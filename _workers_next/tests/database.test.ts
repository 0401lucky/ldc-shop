import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../src/lib/db/schema';
import { migrateDatabase } from '../src/lib/db/migrate';
import { queryCardStock } from '../src/lib/db/card-stock';
import { CURRENT_SCHEMA_VERSION } from '../src/lib/db/schema-version';

type Query = { sql: string; bindings: unknown[] };
function recordQueries(database: D1Database, queries: Query[]): D1Database {
    return new Proxy(database, { get(target, key) {
        if (key === 'prepare') return (sql: string) => {
            const query: Query = { sql, bindings: [] };
            queries.push(query);
            const statement = target.prepare(sql);
            return new Proxy(statement, { get(statementTarget, statementKey) {
                if (statementKey === 'bind') return (...bindings: unknown[]) => {
                    query.bindings = bindings;
                    return statementTarget.bind(...bindings);
                };
                const value = Reflect.get(statementTarget, statementKey);
                return typeof value === 'function' ? value.bind(statementTarget) : value;
            } });
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
}

async function createDatabase() {
    return getPlatformProxy<{ DB: D1Database }>({
        configPath: resolve('tests/fixtures/wrangler.json'),
        persist: false,
        remoteBindings: false,
        envFiles: [],
    });
}

test('deployment migration supports old databases and repeats without writes', async () => {
    const platform = await createDatabase();
    try {
        const database = platform.env.DB;
        await database.prepare('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)').run();
        await database.prepare("INSERT INTO settings (key,value) VALUES ('schema_version','21'),('shop_name','Existing shop')").run();
        await database.prepare('CREATE TABLE products (id TEXT PRIMARY KEY, name TEXT NOT NULL, price TEXT NOT NULL)').run();
        await database.prepare("INSERT INTO products (id,name,price) VALUES ('legacy','Original product','5')").run();
        assert.deepEqual(await migrateDatabase(database), { migrated: true, version: CURRENT_SCHEMA_VERSION });
        const product = await database.prepare("SELECT name, product_images, stock_count FROM products WHERE id='legacy'").first();
        assert.deepEqual(product, { name: 'Original product', product_images: null, stock_count: 0 });
        assert.equal(await database.prepare("SELECT value FROM settings WHERE key='shop_name'").first('value'), 'Existing shop');
        const queries: Query[] = [];
        assert.deepEqual(await migrateDatabase(recordQueries(database, queries)), { migrated: false, version: CURRENT_SCHEMA_VERSION });
        assert.equal(queries.length, 1);
        assert.match(queries[0].sql, /^select/i);
    } finally {
        await platform.dispose();
    }
});

test('D1 runtime preserves stock semantics and eliminates repeated reads/writes', async t => {
    const platform = await createDatabase();
    const previousContext = Reflect.get(globalThis, Symbol.for('__cloudflare-context__'));
    const previousNodeEnv = process.env.NODE_ENV;
    const queries: Query[] = [];
    try {
        const database = platform.env.DB;
        const tracked = recordQueries(database, queries);
        const db = drizzle(tracked, { schema });
        Reflect.set(globalThis, Symbol.for('__cloudflare-context__'), { env: { DB: tracked }, ctx: platform.ctx, cf: platform.cf });
        Object.assign(process.env, { NODE_ENV: 'production' });
        const runtime = await import('../src/lib/db/queries');
        await t.test('an unmigrated database fails read-only and can retry after migration', async () => {
            queries.length = 0;
            await assert.rejects(runtime.getActiveProducts(), /db:migrate:remote/);
            assert.equal(queries.length, 1);
            assert.match(queries[0].sql, /^SELECT/i);
            await migrateDatabase(database);
            assert.deepEqual(await runtime.getActiveProducts(), []);
        });
        await database.prepare("INSERT INTO products (id,name,price) VALUES ('stock','Stock test','1'), ('empty','Empty','1'), ('expire-a','A','1'), ('expire-b','B','1')").run();
        const now = 1_800_000_000_000;
        const cutoff = now - 300_000;
        await database.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000) INSERT INTO cards (product_id,card_key,is_used) SELECT 'stock','history-' || i,1 FROM n").run();
        for (const [key, used, reserved, expires] of [
            ['available', 0, null, null],
            ['legacy-null', null, null, null],
            ['old-lock', 0, cutoff - 1, null],
            ['boundary-lock', 0, cutoff, null],
            ['locked', 0, now, null],
            ['expired-boundary', 0, null, now],
            ['expired', 0, null, now - 1],
        ]) {
            await database.prepare('INSERT INTO cards (product_id,card_key,is_used,reserved_at,expires_at) VALUES (?,?,?,?,?)')
                .bind('stock', key, used, reserved, expires).run();
        }

        await t.test('stock scans the unused partial index with identical counts', async () => {
            queries.length = 0;
            const stats = await queryCardStock(db, ['stock', 'empty', 'stock'], now);
            assert.deepEqual(stats.get('stock'), { unused: 5, available: 3, locked: 2 });
            assert.deepEqual(stats.get('empty'), { unused: 0, available: 0, locked: 0 });
            const query = queries[0];
            const plan = await database.prepare('EXPLAIN QUERY PLAN ' + query.sql).bind(...query.bindings).all<{ detail: string }>();
            assert.ok(plan.results.some(row => row.detail.includes('cards_unused_stock_idx')));
            const optimized = await database.prepare(query.sql).bind(...query.bindings).all();
            const baseline = await database.prepare('SELECT SUM(CASE WHEN COALESCE(is_used,0)=0 AND (expires_at IS NULL OR expires_at>?) THEN 1 ELSE 0 END) FROM cards WHERE product_id=?').bind(now, 'stock').all();
            assert.ok(optimized.meta.rows_read < baseline.meta.rows_read / 10);
            t.diagnostic(`Synthetic stock rows read: ${baseline.meta.rows_read} -> ${optimized.meta.rows_read}`);
            queries.length = 0;
            const many = await queryCardStock(db, Array.from({ length: 125 }, (_, i) => `missing-${i}`), now);
            assert.equal(many.size, 125);
            assert.equal(queries.length, 3);
            assert.ok(queries.every(query => query.bindings.length < 100));
        });

        await t.test('display settings share a snapshot; business controls stay fresh', async () => {
            await runtime.setSetting('shop_name', 'Before');
            await runtime.setSetting('checkin_reward', '1');
            await runtime.invalidatePublicDataCache();
            queries.length = 0;
            assert.deepEqual(await Promise.all([runtime.getSetting('shop_name'), runtime.getSetting('theme_color')]), ['Before', null]);
            assert.equal(await runtime.getSetting('shop_name'), 'Before');
            assert.equal(queries.length, 1);
            await runtime.setSetting('shop_name', 'After');
            assert.equal(await runtime.getSetting('shop_name'), 'After');
            assert.equal(await runtime.getSetting('checkin_reward'), '1');
            await database.prepare("UPDATE settings SET value='8' WHERE key='checkin_reward'").run();
            assert.equal(await runtime.getSetting('checkin_reward'), '8');
        });

        await t.test('visitor counts are reused and login stores email in one write', async () => {
            queries.length = 0;
            await runtime.recordLoginUser('user-1', 'alice', 'first@example.invalid');
            assert.equal(queries.length, 1);
            await runtime.recordLoginUser('user-1', 'alice', 'changed@example.invalid');
            assert.equal(await runtime.getLoginUserEmail('user-1'), 'first@example.invalid');
            await runtime.invalidatePublicDataCache();
            queries.length = 0;
            assert.equal(await runtime.getVisitorCount(), 1);
            assert.equal(await runtime.getVisitorCount(), 1);
            assert.equal(queries.length, 1);
            assert.match(queries[0].sql, /count\(\*\)/i);
        });

        await t.test('homepage and notification reads contain no DDL', async () => {
            queries.length = 0;
            await runtime.getActiveProducts();
            await runtime.getLiveCardStats(['stock']);
            await runtime.getCategories();
            await runtime.getUserUnreadNotificationCount('user-1');
            assert.ok(queries.length > 0);
            assert.ok(queries.every(query => !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(query.sql)));
        });

        await t.test('shared stock, reservations, sales and ratings retain their aggregate semantics', async () => {
            await database.prepare("INSERT INTO products (id,name,price,is_shared) VALUES ('shared','Shared','1',1)").run();
            await database.prepare("INSERT INTO cards (product_id,card_key,reserved_at) VALUES ('shared','reusable',?)").bind(Date.now()).run();
            for (const [status, quantity] of [['paid', 2], ['delivered', 3], ['pending', 4]]) {
                await database.prepare('INSERT INTO orders (order_id,product_id,product_name,amount,status,quantity) VALUES (?,?,?,?,?,?)')
                    .bind(`order-${status}`, 'shared', 'Shared', '1', status, quantity).run();
            }
            await database.prepare("INSERT INTO reviews (product_id,order_id,user_id,username,rating) VALUES ('shared','order-paid','user-1','alice',4)").run();
            await runtime.recalcProductAggregates('shared');
            assert.deepEqual(await database.prepare("SELECT stock_count,locked_count,sold_count,rating,review_count FROM products WHERE id='shared'").first(), {
                stock_count: 999999, locked_count: 1, sold_count: 5, rating: 4, review_count: 1,
            });
        });

        await t.test('empty cleanup performs no writes and scoped cleanup leaves other products alone', async () => {
            queries.length = 0;
            assert.equal(await runtime.cleanupExpiredCardsIfNeeded(0, 'empty'), false);
            assert.deepEqual(await runtime.cancelExpiredOrders(), []);
            assert.ok(queries.every(query => !/\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(query.sql)));
            for (const product of ['expire-a', 'expire-b']) {
                await database.prepare('INSERT INTO cards (product_id,card_key,expires_at) VALUES (?,?,?)').bind(product, 'expired', Date.now() - 1000).run();
            }
            queries.length = 0;
            assert.equal(await runtime.cleanupExpiredCardsIfNeeded(0, 'expire-a'), true);
            assert.equal(await database.prepare("SELECT count(*) AS n FROM cards WHERE product_id='expire-a'").first('n'), 0);
            assert.equal(await database.prepare("SELECT count(*) AS n FROM cards WHERE product_id='expire-b'").first('n'), 1);
            assert.ok(queries.every(query => !/\b(?:insert into|update)\s+["`]?settings/i.test(query.sql)));
        });
    } finally {
        Reflect.set(globalThis, Symbol.for('__cloudflare-context__'), previousContext);
        if (previousNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
        else Object.assign(process.env, { NODE_ENV: previousNodeEnv });
        await platform.dispose();
    }
});
