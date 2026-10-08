import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPublicCache } from '../src/lib/public-cache';

test('public cache deduplicates loads, expires and retries failures', async () => {
    const cache = createPublicCache<number>('unit', 0.02);
    let loads = 0;
    const load = async () => ++loads;
    assert.deepEqual(await Promise.all([cache.get(load), cache.get(load)]), [1, 1]);
    assert.equal(await cache.get(load), 1);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(await cache.get(load), 2);
    await cache.invalidate();
    await assert.rejects(cache.get(async () => { throw new Error('database unavailable'); }));
    assert.equal(await cache.get(load), 3);
});

test('invalidation prevents an in-flight old load from replacing a new value', async () => {
    const cache = createPublicCache<string>('race', 60);
    let finish!: (value: string) => void;
    const old = cache.get(() => new Promise(resolve => { finish = resolve; }));
    await cache.invalidate();
    assert.equal(await cache.get(async () => 'new'), 'new');
    finish('old');
    assert.equal(await old, 'old');
    assert.equal(await cache.get(async () => 'unexpected'), 'new');
});

test('Cache API shares public values across instances and honors invalidation', async () => {
    const previousCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
    const previousOrigin = process.env.NEXT_PUBLIC_APP_URL;
    const responses = new Map<string, Response>();
    Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
        match: async (request: Request) => responses.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => { responses.set(request.url, response.clone()); },
        delete: async (request: Request) => responses.delete(request.url),
    } } });
    process.env.NEXT_PUBLIC_APP_URL = 'https://shop.example';
    try {
        const first = createPublicCache<number>('shared', 60);
        const second = createPublicCache<number>('shared', 60);
        assert.equal(await first.get(async () => 12), 12);
        assert.equal(await second.get(async () => 99), 12);
        await second.invalidate();
        assert.equal(await second.get(async () => 13), 13);
        assert.equal(await createPublicCache<number>('shared', 60).get(async () => 99), 13);
    } finally {
        if (previousCaches) Object.defineProperty(globalThis, 'caches', previousCaches);
        else Reflect.deleteProperty(globalThis, 'caches');
        if (previousOrigin === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
        else process.env.NEXT_PUBLIC_APP_URL = previousOrigin;
    }
});
