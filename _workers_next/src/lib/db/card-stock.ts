import { and, inArray, sql } from 'drizzle-orm';
import { cards } from './schema';
import { RESERVATION_TTL_MS } from '../constants';
import type { db as appDb } from './index';

export type CardStock = { unused: number; available: number; locked: number };

export async function queryCardStock(db: typeof appDb, productIds: string[], nowMs = Date.now()) {
    const ids = Array.from(new Set(productIds.map(id => String(id).trim()).filter(Boolean)));
    const stats = new Map<string, CardStock>(ids.map(id => [id, { unused: 0, available: 0, locked: 0 }]));
    const cutoff = nowMs - RESERVATION_TTL_MS;
    // Stay below D1's bound parameter limit, including timestamps.
    for (let offset = 0; offset < ids.length; offset += 50) {
        const rows = await db.select({
            productId: cards.productId,
            unused: sql<number>`COUNT(*)`,
            available: sql<number>`SUM(CASE WHEN ${cards.reservedAt} IS NULL OR ${cards.reservedAt} < ${cutoff} THEN 1 ELSE 0 END)`,
            locked: sql<number>`SUM(CASE WHEN ${cards.reservedAt} IS NOT NULL AND ${cards.reservedAt} >= ${cutoff} THEN 1 ELSE 0 END)`,
        }).from(cards).where(and(
            inArray(cards.productId, ids.slice(offset, offset + 50)),
            // This predicate also matches cards_unused_stock_idx's partial index.
            sql`COALESCE(${cards.isUsed}, 0) = 0`,
            sql`(${cards.expiresAt} IS NULL OR ${cards.expiresAt} > ${nowMs})`,
        )).groupBy(cards.productId);
        for (const row of rows) {
            stats.set(row.productId, {
                unused: Number(row.unused),
                available: Number(row.available),
                locked: Number(row.locked),
            });
        }
    }
    return stats;
}
