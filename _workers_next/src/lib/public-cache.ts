type CacheEntry<T> = { value: T; expiresAt: number };

// The Cache API survives Worker isolate restarts within a data center. Only
// public, non-user-specific values belong here; it is independent of Next ISR.
export function createPublicCache<T>(key: string, ttlSeconds: number) {
    let entry: CacheEntry<T> | undefined;
    let pending: Promise<T> | undefined;
    let generation = 0;

    function edgeCache() {
        try {
            const origin = process.env.NEXT_PUBLIC_APP_URL;
            const storage = globalThis.caches as CacheStorage & { default?: Cache };
            if (!origin || !storage?.default) return undefined;
            const url = new URL(`/__ldc_public_cache/v1/${key}`, new URL(origin).origin);
            return { cache: storage.default, request: new Request(url) };
        } catch {
            return undefined;
        }
    }

    return {
        async get(load: () => Promise<T>): Promise<T> {
            if (entry && entry.expiresAt > Date.now()) return entry.value;
            if (pending) return pending;
            const startedGeneration = generation;
            const work = (async () => {
                const edge = edgeCache();
                if (edge) {
                    try {
                        const response = await edge.cache.match(edge.request);
                        if (response) {
                            const cached = await response.json() as CacheEntry<T>;
                            if (cached.expiresAt > Date.now()) {
                                if (generation === startedGeneration) entry = cached;
                                return cached.value;
                            }
                        }
                    } catch {
                        // Cache availability must not affect database reads.
                    }
                }

                const value = await load();
                const next = { value, expiresAt: Date.now() + ttlSeconds * 1000 };
                if (generation === startedGeneration) {
                    entry = next;
                    if (edge) {
                        try {
                            await edge.cache.put(edge.request, new Response(JSON.stringify(next), {
                                headers: {
                                    'Content-Type': 'application/json',
                                    'Cache-Control': `public, max-age=${ttlSeconds}`,
                                },
                            }));
                            if (generation !== startedGeneration) await edge.cache.delete(edge.request);
                        } catch {
                            // Keep the bounded in-memory fallback when Cache API is unavailable.
                        }
                    }
                }
                return value;
            })();
            pending = work;
            try {
                return await work;
            } finally {
                if (pending === work) pending = undefined;
            }
        },

        async invalidate() {
            generation++;
            entry = undefined;
            pending = undefined;
            const edge = edgeCache();
            if (edge) {
                try {
                    await edge.cache.delete(edge.request);
                } catch {
                    // Other data centers expire naturally at the short TTL.
                }
            }
        },
    };
}
