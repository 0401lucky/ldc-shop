import type { D1Database } from '@cloudflare/workers-types';

type Query = { sql: string; params: unknown[] };
type RawResult = {
    success?: boolean;
    error?: string;
    meta?: Record<string, unknown>;
    results?: { columns?: string[]; rows?: unknown[][] };
};

// Only used by the migration CLI. The application continues to use its D1 binding.
export function createD1HttpDatabase(options: {
    accountId: string;
    databaseId: string;
    token: string;
    fetch?: typeof fetch;
}): D1Database {
    const request = options.fetch || fetch;
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/raw`;

    async function execute(body: Query | { batch: Query[] }): Promise<RawResult[]> {
        const response = await request(url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
        const payload = await response.json() as {
            success?: boolean;
            result?: RawResult[];
            errors?: Array<{ message?: string }>;
        };
        if (!response.ok || !payload.success || !payload.result?.length) {
            throw new Error(`D1 API (${response.status}): ${payload.errors?.map(error => error.message).join('; ') || 'Missing query results'}`);
        }
        const failed = payload.result.find(result => result.success === false);
        if (failed) throw new Error(`D1 API: ${failed.error || 'Query failed'}`);
        return payload.result;
    }

    function asObjects(result: RawResult) {
        const { columns = [], rows = [] } = result.results || {};
        return { ...result, success: true, results: rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]]))) };
    }

    class Statement {
        constructor(readonly query: Query) {}
        bind(...params: unknown[]) { return new Statement({ sql: this.query.sql, params }); }
        async all() { return asObjects((await execute(this.query))[0]); }
        async run() { return this.all(); }
        async first(column?: string) {
            const row = (await this.all()).results[0];
            return column ? row?.[column] ?? null : row ?? null;
        }
        async raw(rawOptions?: { columnNames?: boolean }) {
            const result = (await execute(this.query))[0].results || {};
            return rawOptions?.columnNames ? [result.columns || [], ...(result.rows || [])] : result.rows || [];
        }
    }

    return {
        prepare(sql: string) { return new Statement({ sql, params: [] }); },
        async batch(statements: Statement[]) {
            return (await execute({ batch: statements.map(statement => statement.query) })).map(asObjects);
        },
        async exec(sql: string) {
            const results = await execute({ sql, params: [] });
            return { count: results.length, duration: results.reduce((sum, result) => sum + Number(result.meta?.duration || 0), 0) };
        },
    } as unknown as D1Database;
}
