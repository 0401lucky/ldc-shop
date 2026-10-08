import { and, eq, inArray, sql } from 'drizzle-orm';
import { products, orders, reviews } from './schema';
import { queryCardStock } from './card-stock';
import { INFINITE_STOCK } from '../constants';
import type { db as appDb } from './index';

export async function updateProductAggregates(db: typeof appDb, productIds: string[]) {
    const ids = Array.from(new Set(productIds.map(id => String(id).trim()).filter(Boolean)));
    const now = Date.now();
    for (let offset = 0; offset < ids.length; offset += 50) {
        const batch = ids.slice(offset, offset + 50);
        const productRows = await db.select({ id: products.id, isShared: products.isShared })
            .from(products).where(inArray(products.id, batch));
        if (!productRows.length) continue;
        const existingIds = productRows.map(row => row.id);
        const stock = await queryCardStock(db, existingIds, now);
        const soldRows = await db.select({
            productId: orders.productId,
            sold: sql<number>`COALESCE(SUM(${orders.quantity}), 0)`,
        }).from(orders).where(and(
            inArray(orders.productId, existingIds),
            inArray(orders.status, ['paid', 'delivered']),
        )).groupBy(orders.productId);
        const reviewRows = await db.select({
            productId: reviews.productId,
            rating: sql<number>`COALESCE(AVG(${reviews.rating}), 0)`,
            count: sql<number>`COUNT(*)`,
        }).from(reviews).where(inArray(reviews.productId, existingIds)).groupBy(reviews.productId);
        const sales = new Map(soldRows.map(row => [row.productId, Number(row.sold)]));
        const ratings = new Map(reviewRows.map(row => [row.productId, row]));

        for (let index = 0; index < productRows.length; index += 8) {
            await Promise.all(productRows.slice(index, index + 8).map(product => {
                const counts = stock.get(product.id)!;
                const rating = ratings.get(product.id);
                return db.update(products).set({
                    stockCount: product.isShared ? (counts.unused > 0 ? INFINITE_STOCK : 0) : counts.available,
                    lockedCount: counts.locked,
                    soldCount: sales.get(product.id) || 0,
                    rating: Number(rating?.rating || 0),
                    reviewCount: Number(rating?.count || 0),
                }).where(eq(products.id, product.id));
            }));
        }
    }
}
