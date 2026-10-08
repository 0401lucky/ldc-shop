import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { getPlatformProxy, unstable_readConfig, type Unstable_Config } from 'wrangler';
import type { D1Database } from '@cloudflare/workers-types';
import { migrateDatabase } from '../src/lib/db/migrate';
import { createD1HttpDatabase } from './d1-http';

const { values } = parseArgs({ options: {
    remote: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    config: { type: 'string', default: 'wrangler.json' },
    env: { type: 'string' },
} });
if (values.local && values.remote) throw new Error('Choose --local or --remote, not both');

const config: Unstable_Config = unstable_readConfig({ config: resolve(values.config), env: values.env });
const binding = config.d1_databases.find(database => database.binding === 'DB');
if (!binding) throw new Error('Missing D1 binding DB in Wrangler configuration');
const database = { ...binding, remote: values.remote };
if (values.remote) delete database.preview_database_id;
if (values.remote && !database.database_id) {
    if (!database.database_name) throw new Error('Configure database_name or database_id for the D1 binding');
    const require = createRequire(import.meta.url);
    const cli = require.resolve('wrangler/bin/wrangler.js');
    // `d1 info <name>` rejects a configured binding without an ID. Resolve the
    // name from the account's database list before creating the remote binding.
    const databases: Array<{ name: string; uuid: string }> = JSON.parse(execFileSync(process.execPath, [
        cli, 'd1', 'list', '--json', '--config', resolve(values.config),
        ...(values.env ? ['--env', values.env] : []),
    ], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    }));
    database.database_id = databases.find(candidate => candidate.name === database.database_name)?.uuid;
    if (!database.database_id) throw new Error('Unable to resolve D1 database ID; configure database_id in wrangler.json');
}

if (values.remote) {
    const accountId = config.account_id || process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId || !database.database_id) throw new Error('Configure account_id and database_id before remote migration');
    const require = createRequire(import.meta.url);
    const credentials: { token?: string } = JSON.parse(execFileSync(process.execPath, [
        require.resolve('wrangler/bin/wrangler.js'), 'auth', 'token', '--json', '--config', resolve(values.config),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
    if (!credentials.token) throw new Error('Wrangler OAuth or CLOUDFLARE_API_TOKEN authentication is required');
    console.log(`Migrating ${database.database_name} (remote)`);
    const result = await migrateDatabase(createD1HttpDatabase({ accountId, databaseId: database.database_id, token: credentials.token }));
    console.log(result.migrated ? `Migrated to schema ${result.version}` : `Schema ${result.version} is already current`);
} else {
    const directory = await mkdtemp(join(tmpdir(), 'ldc-db-migrate-'));
    const configPath = join(directory, 'wrangler.json');
    let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
    try {
        // Only bind D1; migrations do not load the app, its secrets, assets, or cron.
        await writeFile(configPath, JSON.stringify({
            name: config.name,
            account_id: config.account_id,
            compatibility_date: config.compatibility_date,
            compatibility_flags: ['nodejs_compat'],
            d1_databases: [database],
        }));
        console.log(`Migrating ${database.database_name} (${values.remote ? 'remote' : 'local'})`);
        platform = await getPlatformProxy<{ DB: D1Database }>({
            configPath,
            envFiles: [],
            remoteBindings: values.remote,
            persist: { path: resolve('.wrangler/state/v3') },
        });
        const result = await migrateDatabase(platform.env.DB);
        console.log(result.migrated ? `Migrated to schema ${result.version}` : `Schema ${result.version} is already current`);
    } finally {
        await platform?.dispose();
        await unlink(configPath).catch(() => {});
        await rmdir(directory);
    }
}
