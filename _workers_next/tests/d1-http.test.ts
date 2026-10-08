import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createD1HttpDatabase } from '../scripts/d1-http';

test('D1 HTTP adapter preserves raw column order, bindings and batch payloads', async () => {
    const requests: Array<{ body: unknown; url: string }> = [];
    const database = createD1HttpDatabase({
        accountId: 'account', databaseId: 'database', token: 'test-token',
        fetch: async (url, init) => {
            assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-token');
            const body = JSON.parse(String(init?.body));
            requests.push({ body, url: String(url) });
            const batch = body.batch || [body];
            return Response.json({ success: true, result: batch.map(() => ({
                success: true, meta: { changes: 0 }, results: { columns: ['z', 'a'], rows: [[2, 1]] },
            })) });
        },
    });
    assert.deepEqual(await database.prepare('SELECT ? AS z, ? AS a').bind(2, null).raw(), [[2, 1]]);
    assert.deepEqual(requests[0].body, { sql: 'SELECT ? AS z, ? AS a', params: [2, null] });
    assert.ok(requests[0].url.endsWith('/d1/database/database/raw'));
    assert.deepEqual((await database.prepare('SELECT 2 AS z, 1 AS a').all()).results, [{ z: 2, a: 1 }]);
    assert.equal(await database.prepare('SELECT 2 AS z, 1 AS a').first('a'), 1);
    assert.deepEqual(await database.prepare('SELECT 2 AS z, 1 AS a').raw({ columnNames: true }), [['z', 'a'], [2, 1]]);
    const result = await database.batch([database.prepare('SELECT ?').bind('one'), database.prepare('SELECT ?').bind('two')]);
    assert.equal(result.length, 2);
    assert.deepEqual(requests.at(-1)?.body, { batch: [{ sql: 'SELECT ?', params: ['one'] }, { sql: 'SELECT ?', params: ['two'] }] });
});

test('D1 HTTP adapter rejects API errors without exposing credentials', async () => {
    const database = createD1HttpDatabase({
        accountId: 'account', databaseId: 'database', token: 'must-not-leak',
        fetch: async () => Response.json({ success: false, errors: [{ message: 'Denied' }] }, { status: 403 }),
    });
    await assert.rejects(database.prepare('SELECT 1').all(), error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /D1 API \(403\): Denied/);
        assert.ok(!error.message.includes('must-not-leak'));
        return true;
    });
});
