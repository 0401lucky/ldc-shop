import { sql } from 'drizzle-orm';
import { db } from './index';
import { CURRENT_SCHEMA_VERSION, MIGRATION_REQUIRED_MESSAGE } from './schema-version';

let ready = false;
let pending: Promise<void> | undefined;

// Runtime checks are read-only. Schema/data migrations run from scripts/migrate.mts.
export async function ensureDatabaseReady(): Promise<void> {
    if (ready) return;
    if (pending) return pending;
    const work = (async () => {
        let version: number;
        try {
            const rows = await db.all<{ value: string }>(sql`SELECT value FROM settings WHERE key = 'schema_version'`);
            version = Number(rows[0]?.value);
        } catch {
            throw new Error(MIGRATION_REQUIRED_MESSAGE);
        }
        if (!Number.isFinite(version) || version < CURRENT_SCHEMA_VERSION) {
            throw new Error(MIGRATION_REQUIRED_MESSAGE);
        }
        ready = true;
    })();
    pending = work;
    try {
        await work;
    } finally {
        if (pending === work) pending = undefined;
    }
}
