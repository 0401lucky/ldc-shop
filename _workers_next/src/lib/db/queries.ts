import { db } from "./index";
import { products, cards, orders, settings, reviews, reviewReplies, loginUsers, categories, userNotifications, wishlistItems, wishlistVotes } from "./schema";
import { RESERVATION_TTL_MS } from "@/lib/constants";
import { eq, sql, desc, and, asc, gte, or, inArray, lte, lt, isNull } from "drizzle-orm";
import { updateTag, revalidatePath } from "next/cache";
import { cache } from "react";
import { ensureDatabaseReady } from './ready';
import { queryCardStock, type CardStock } from './card-stock';
import { updateProductAggregates } from './product-aggregates';
import { createPublicCache } from '../public-cache';

// Keep payment controls, rewards, credentials and per-user keys uncached.
const PUBLIC_SETTING_KEYS = [
    'shop_name', 'shop_description', 'shop_footer', 'shop_logo', 'shop_logo_source',
    'shop_logo_updated_at', 'noindex_enabled', 'theme_color', 'theme_font',
    'currency_unit', 'announcement',
];
const publicSettingsCache = createPublicCache<Record<string, string | null>>('settings', 60);
const visitorCountCache = createPublicCache<number>('visitors', 300);

export async function invalidatePublicDataCache() {
    await Promise.all([publicSettingsCache.invalidate(), visitorCountCache.invalidate()]);
}

export { ensureDatabaseReady as ensureLoginUsersSchema } from './ready';

export async function recalcProductAggregates(productId: string) {
    await ensureDatabaseReady();
    await updateProductAggregates(db, [productId]);
}

export async function recalcProductAggregatesForMany(productIds: string[]) {
    await ensureDatabaseReady();
    await updateProductAggregates(db, productIds);
}

export async function getLiveCardStats(productIds: string[]) {
    if (!productIds.length) return new Map<string, CardStock>();
    await ensureDatabaseReady();
    return queryCardStock(db, productIds);
}

async function withProductColumnFallback<T>(fn: () => Promise<T>): Promise<T> {
    await ensureDatabaseReady();
    return fn();
}

export async function withOrderColumnFallback<T>(fn: () => Promise<T>): Promise<T> {
    await ensureDatabaseReady();
    return fn();
}

export async function getProducts() {
    return await withProductColumnFallback(async () => {
        return await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            maxPointsDiscount: products.maxPointsDiscount,
            image: products.image,
            productImages: products.productImages,
            category: products.category,
            isHot: products.isHot,
            isActive: products.isActive,
            isShared: products.isShared,
            visibilityLevel: products.visibilityLevel,
            sortOrder: products.sortOrder,
            purchaseLimit: products.purchaseLimit,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`
        })
            .from(products)
            .orderBy(asc(products.sortOrder), desc(products.createdAt));
    })
}

function resolveVisibilityThreshold(isLoggedIn?: boolean, trustLevel?: number | null) {
    if (!isLoggedIn) return -1;
    const level = Number.isFinite(Number(trustLevel)) ? Number(trustLevel) : 0;
    return Math.max(0, level);
}

function visibilityCondition(isLoggedIn?: boolean, trustLevel?: number | null) {
    const threshold = resolveVisibilityThreshold(isLoggedIn, trustLevel);
    return lte(sql<number>`COALESCE(${products.visibilityLevel}, -1)`, threshold);
}

// Get only active products (for home page); groups by variant_group_id and returns one representative per group with variantCount and priceRange
export async function getActiveProducts(options?: { isLoggedIn?: boolean; trustLevel?: number | null }) {
    // Verify deployment migrations before querying
    await ensureDatabaseReady();

    const rows = await withProductColumnFallback(async () => {
        return await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            maxPointsDiscount: products.maxPointsDiscount,
            image: products.image,
            productImages: products.productImages,
            category: products.category,
            isHot: products.isHot,
            isShared: products.isShared,
            purchaseLimit: products.purchaseLimit,
            visibilityLevel: products.visibilityLevel,
            sortOrder: products.sortOrder,
            createdAt: products.createdAt,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
            rating: sql<number>`COALESCE(${products.rating}, 0)`,
            reviewCount: sql<number>`COALESCE(${products.reviewCount}, 0)`
        })
            .from(products)
            .where(and(eq(products.isActive, true), visibilityCondition(options?.isLoggedIn, options?.trustLevel)))
            .orderBy(asc(products.sortOrder), desc(products.createdAt));
    });

    return groupProductsAsVariants(rows);
}

function groupProductsAsVariants<T extends {
    id: string;
    price: string;
    variantGroupId: string | null;
    sortOrder: number | null;
    createdAt: Date | null;
    sold?: number;
    stock?: number;
    locked?: number;
    rating?: number;
    reviewCount?: number;
    isHot?: boolean | null;
    isShared?: boolean | null;
}>(rows: T[]): (T & { variantCount?: number; priceMin?: number; priceMax?: number; totalSold?: number; totalStock?: number; totalLocked?: number; totalReviewCount?: number; avgRating?: number; groupHot?: boolean; groupShared?: boolean; allVariantIds?: string[] })[] {
    const byGroup = new Map<string, T[]>();
    for (const row of rows) {
        const rawKey = (row.variantGroupId && row.variantGroupId.trim()) || null;
        const key = rawKey ?? row.id;
        const list = byGroup.get(key) ?? [];
        list.push(row);
        byGroup.set(key, list);
    }
    const result: (T & { variantCount?: number; priceMin?: number; priceMax?: number; totalSold?: number; totalStock?: number; totalLocked?: number; totalReviewCount?: number; avgRating?: number; groupHot?: boolean; groupShared?: boolean; allVariantIds?: string[] })[] = [];
    for (const list of byGroup.values()) {
        const rep = list.slice().sort((a, b) => {
            const soA = a.sortOrder ?? 0;
            const soB = b.sortOrder ?? 0;
            if (soA !== soB) return soA - soB;
            const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return ca - cb;
        })[0];
        const prices = list.map((p) => parseFloat(p.price)).filter((n) => Number.isFinite(n));
        const variantCount = list.length;
        const priceMin = prices.length ? Math.min(...prices) : undefined;
        const priceMax = prices.length ? Math.max(...prices) : undefined;

        if (variantCount > 1) {
            const totalSold = list.reduce((s, p) => s + (p.sold || 0), 0);
            const totalStock = list.reduce((s, p) => s + (p.stock || 0), 0);
            const totalLocked = list.reduce((s, p) => s + (p.locked || 0), 0);
            const totalReviewCount = list.reduce((s, p) => s + (p.reviewCount || 0), 0);
            const ratingSum = list.reduce((s, p) => s + (p.rating || 0) * (p.reviewCount || 0), 0);
            const avgRating = totalReviewCount > 0 ? ratingSum / totalReviewCount : 0;
            const groupHot = list.some((p) => !!p.isHot);
            const groupShared = list.some((p) => !!p.isShared);
            const allVariantIds = list.map((p) => p.id);
            result.push({ ...rep, variantCount, priceMin, priceMax, totalSold, totalStock, totalLocked, totalReviewCount, avgRating, groupHot, groupShared, allVariantIds });
        } else {
            result.push({ ...rep });
        }
    }
    result.sort((a, b) => {
        const soA = a.sortOrder ?? 0;
        const soB = b.sortOrder ?? 0;
        if (soA !== soB) return soA - soB;
        const ca = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const cb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return ca - cb;
    });
    return result;
}

export async function getWishlistItems(userId: string | null, limit = 10) {
    await ensureDatabaseReady();

    try {
        const result: any = await db.run(sql`
            SELECT
                wi.id AS id,
                wi.title AS title,
                wi.description AS description,
                wi.username AS username,
                wi.created_at AS created_at,
                COUNT(wv.id) AS votes,
                SUM(CASE WHEN wv.user_id = ${userId} THEN 1 ELSE 0 END) AS voted
            FROM wishlist_items wi
            LEFT JOIN wishlist_votes wv ON wv.item_id = wi.id
            GROUP BY wi.id
            ORDER BY votes DESC, wi.created_at DESC
            LIMIT ${limit}
        `);

        const rows = result?.results || result?.rows || [];
        return rows.map((row: any) => ({
            id: Number(row.id),
            title: row.title,
            description: row.description,
            username: row.username,
            createdAt: Number(row.created_at ?? row.createdAt ?? 0),
            votes: Number(row.votes || 0),
            voted: Number(row.voted || 0) > 0,
        }));
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) {
            await ensureDatabaseReady();
            // Retry once
            try {
                const result: any = await db.run(sql`
                    SELECT
                        wi.id AS id,
                        wi.title AS title,
                        wi.description AS description,
                        wi.username AS username,
                        wi.created_at AS created_at,
                        COUNT(wv.id) AS votes,
                        SUM(CASE WHEN wv.user_id = ${userId} THEN 1 ELSE 0 END) AS voted
                    FROM wishlist_items wi
                    LEFT JOIN wishlist_votes wv ON wv.item_id = wi.id
                    GROUP BY wi.id
                    ORDER BY votes DESC, wi.created_at DESC
                    LIMIT ${limit}
                `);
                const rows = result?.results || result?.rows || [];
                return rows.map((row: any) => ({
                    id: Number(row.id),
                    title: row.title,
                    description: row.description,
                    username: row.username,
                    createdAt: Number(row.created_at ?? row.createdAt ?? 0),
                    votes: Number(row.votes || 0),
                    voted: Number(row.voted || 0) > 0,
                }));
            } catch (retryError) {
                console.error('getWishlistItems retry failed:', retryError);
                return [];
            }
        }
        console.error('getWishlistItems failed:', error);
        return [];
    }
}

export async function getProduct(id: string, options?: { isLoggedIn?: boolean; trustLevel?: number | null }) {
    return await withProductColumnFallback(async () => {
        const result = await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            maxPointsDiscount: products.maxPointsDiscount,
            image: products.image,
            productImages: products.productImages,
            category: products.category,
            isHot: products.isHot,
            isActive: products.isActive,
            isShared: products.isShared,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
            purchaseLimit: products.purchaseLimit,
            purchaseWarning: products.purchaseWarning,
            visibilityLevel: products.visibilityLevel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            rating: sql<number>`COALESCE(${products.rating}, 0)`,
            reviewCount: sql<number>`COALESCE(${products.reviewCount}, 0)`,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            purchaseQuestions: products.purchaseQuestions
        })
            .from(products)
            .where(and(eq(products.id, id), visibilityCondition(options?.isLoggedIn, options?.trustLevel)))
            ;

        // Return null if product doesn't exist or is inactive
        const product = result[0];
        if (!product || product.isActive === false) {
            return null;
        }
        return product;
    })
}

export async function getProductVisibility(id: string) {
    return await withProductColumnFallback(async () => {
        const result = await db.select({
            id: products.id,
            isActive: products.isActive,
            visibilityLevel: products.visibilityLevel,
        })
            .from(products)
            .where(eq(products.id, id));

        return result[0] || null;
    });
}

export type ProductVariantRow = {
    id: string;
    name: string;
    description: string | null;
    price: string;
    compareAtPrice: string | null;
    maxPointsDiscount: string | null;
    image: string | null;
    productImages: string | null;
    variantLabel: string | null;
    stock: number;
    locked: number;
    isShared: boolean | null;
    sold: number;
    purchaseLimit: number | null;
    isHot: boolean | null;
    purchaseWarning: string | null;
    purchaseQuestions: string | null;
};

export async function getProductVariants(
    groupId: string,
    options?: { isLoggedIn?: boolean; trustLevel?: number | null }
): Promise<ProductVariantRow[]> {
    return await withProductColumnFallback(async () => {
        return await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            maxPointsDiscount: products.maxPointsDiscount,
            image: products.image,
            productImages: products.productImages,
            variantLabel: products.variantLabel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
            isShared: products.isShared,
            purchaseLimit: products.purchaseLimit,
            isHot: products.isHot,
            purchaseWarning: products.purchaseWarning,
            purchaseQuestions: products.purchaseQuestions,
        })
            .from(products)
            .where(and(
                eq(products.variantGroupId, groupId),
                eq(products.isActive, true),
                visibilityCondition(options?.isLoggedIn, options?.trustLevel)
            ))
            .orderBy(asc(products.sortOrder), desc(products.createdAt));
    });
}

export async function getProductVariantLabels(productIds: string[]): Promise<Record<string, string | null>> {
    const ids = Array.from(new Set((productIds || []).map((id) => String(id).trim()).filter(Boolean)));
    if (!ids.length) return {};
    const rows = await db.select({ id: products.id, variantLabel: products.variantLabel })
        .from(products)
        .where(inArray(products.id, ids));
    const out: Record<string, string | null> = {};
    for (const row of rows) {
        const label = row.variantLabel?.trim() || null;
        if (label) out[row.id] = label;
    }
    return out;
}

export async function getProductForAdmin(id: string) {
    return await withProductColumnFallback(async () => {
        const result = await db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            maxPointsDiscount: products.maxPointsDiscount,
            image: products.image,
            productImages: products.productImages,
            category: products.category,
            isHot: products.isHot,
            isActive: products.isActive,
            isShared: products.isShared,
            purchaseLimit: products.purchaseLimit,
            purchaseWarning: products.purchaseWarning,
            visibilityLevel: products.visibilityLevel,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            purchaseQuestions: products.purchaseQuestions,
        })
            .from(products)
            .where(eq(products.id, id));

        return result[0] || null;
    });
}

// Dashboard Stats
export async function getDashboardStats(nowMs: number) {
    return await withOrderColumnFallback(async () => {
        const now = new Date(nowMs);
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const weekStart = new Date(todayStart);
        weekStart.setDate(weekStart.getDate() - 7);
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const todayStartMs = todayStart.getTime();
        const weekStartMs = weekStart.getTime();
        const monthStartMs = monthStart.getTime();
        const stats = await db.select({
            totalCount: sql<number>`count(*)`,
            totalRevenue: sql<number>`COALESCE(sum(CAST(${orders.amount} AS REAL)), 0)`,
            todayCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${todayStartMs} THEN 1 ELSE 0 END), 0)`,
            todayRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${todayStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
            weekCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${weekStartMs} THEN 1 ELSE 0 END), 0)`,
            weekRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${weekStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
            monthCount: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${monthStartMs} THEN 1 ELSE 0 END), 0)`,
            monthRevenue: sql<number>`COALESCE(sum(CASE WHEN ${orders.paidAt} >= ${monthStartMs} THEN CAST(${orders.amount} AS REAL) ELSE 0 END), 0)`,
        })
            .from(orders)
            .where(eq(orders.status, 'delivered'));

        const row = stats[0] || {
            totalCount: 0,
            totalRevenue: 0,
            todayCount: 0,
            todayRevenue: 0,
            weekCount: 0,
            weekRevenue: 0,
            monthCount: 0,
            monthRevenue: 0,
        };

        return {
            today: { count: row.todayCount || 0, revenue: row.todayRevenue || 0 },
            week: { count: row.weekCount || 0, revenue: row.weekRevenue || 0 },
            month: { count: row.monthCount || 0, revenue: row.monthRevenue || 0 },
            total: { count: row.totalCount || 0, revenue: row.totalRevenue || 0 }
        };
    })
}

export async function getRecentOrders(limit: number = 10) {
    return await withOrderColumnFallback(async () => {
        return await db.query.orders.findMany({
            orderBy: [desc(normalizeTimestampMs(orders.createdAt))],
            limit
        })
    })
}

// Settings
export const getSetting = cache(async (key: string): Promise<string | null> => {
    await ensureDatabaseReady();
    if (PUBLIC_SETTING_KEYS.includes(key)) {
        const values = await publicSettingsCache.get(async () => {
            const rows = await db.select({ key: settings.key, value: settings.value })
                .from(settings).where(inArray(settings.key, PUBLIC_SETTING_KEYS));
            return Object.fromEntries(rows.map(row => [row.key, row.value]));
        });
        return values[key] ?? null;
    }
    const result = await db.select({ value: settings.value })
        .from(settings)
        .where(eq(settings.key, key));
    return result[0]?.value ?? null;
});

export const getAllSettings = cache(async (): Promise<Record<string, string>> => {
    try {
        const rows = await db.select({ key: settings.key, value: settings.value }).from(settings);
        return rows.reduce((acc, row) => {
            acc[row.key] = row.value || '';
            return acc;
        }, {} as Record<string, string>);
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureDatabaseReady();
            return {};
        }
        throw error;
    }
});

export async function setSetting(key: string, value: string): Promise<void> {
    await ensureDatabaseReady();
    await db.insert(settings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
            target: settings.key,
            set: { value, updatedAt: new Date() }
        });
    if (PUBLIC_SETTING_KEYS.includes(key)) await publicSettingsCache.invalidate();
}

// Categories


export async function getCategories(): Promise<Array<{ id: number; name: string; icon: string | null; sortOrder: number }>> {
    try {
        const rows = await db.select({
            id: categories.id,
            name: categories.name,
            icon: categories.icon,
            sortOrder: sql<number>`COALESCE(${categories.sortOrder}, 0)`,
        }).from(categories).orderBy(asc(categories.sortOrder), asc(categories.name))
        return rows
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureDatabaseReady()
            return []
        }
        throw error
    }
}

export async function createUserNotification(params: {
    userId: string | null | undefined
    type: string
    titleKey: string
    contentKey: string
    data?: Record<string, any> | null
}) {
    if (!params.userId) return
    await ensureDatabaseReady()
    try {
        await db.insert(userNotifications).values({
            userId: params.userId,
            type: params.type,
            titleKey: params.titleKey,
            contentKey: params.contentKey,
            data: params.data ? JSON.stringify(params.data) : null,
            isRead: false,
            createdAt: new Date()
        })
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureDatabaseReady()
            await db.insert(userNotifications).values({
                userId: params.userId,
                type: params.type,
                titleKey: params.titleKey,
                contentKey: params.contentKey,
                data: params.data ? JSON.stringify(params.data) : null,
                isRead: false,
                createdAt: new Date()
            })
            return
        }
        throw error
    }
}

export async function getUserNotifications(userId: string, limit: number = 20) {
    await ensureDatabaseReady()
    try {
        return await db.select({
            id: userNotifications.id,
            userId: userNotifications.userId,
            type: userNotifications.type,
            titleKey: userNotifications.titleKey,
            contentKey: userNotifications.contentKey,
            data: userNotifications.data,
            isRead: userNotifications.isRead,
            createdAt: userNotifications.createdAt
        })
            .from(userNotifications)
            .where(eq(userNotifications.userId, userId))
            .orderBy(desc(normalizeTimestampMs(userNotifications.createdAt)))
            .limit(limit)
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureDatabaseReady()
            return []
        }
        throw error
    }
}

export async function markAllUserNotificationsRead(userId: string) {
    await ensureDatabaseReady()
    try {
        await db.update(userNotifications)
            .set({ isRead: true })
            .where(eq(userNotifications.userId, userId))
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureDatabaseReady()
            return
        }
        throw error
    }
}

export async function getUserUnreadNotificationCount(userId: string) {
    await ensureDatabaseReady()
    try {
        const rows = await db.select({
            count: sql<number>`count(*)`
        })
            .from(userNotifications)
            .where(and(eq(userNotifications.userId, userId), eq(userNotifications.isRead, false)))
        return Number(rows[0]?.count || 0)
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureDatabaseReady()
            return 0
        }
        throw error
    }
}

export async function markUserNotificationRead(userId: string, id: number) {
    await ensureDatabaseReady()
    try {
        await db.update(userNotifications)
            .set({ isRead: true })
            .where(and(eq(userNotifications.userId, userId), eq(userNotifications.id, id)))
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureDatabaseReady()
            return
        }
        throw error
    }
}

export async function clearUserNotifications(userId: string) {
    await ensureDatabaseReady()
    try {
        await db.delete(userNotifications)
            .where(eq(userNotifications.userId, userId))
    } catch (error: any) {
        if (isMissingTable(error)) {
            await ensureDatabaseReady()
            return
        }
        throw error
    }
}

export async function searchActiveProducts(params: {
    q?: string
    category?: string
    sort?: string
    page?: number
    pageSize?: number
    isLoggedIn?: boolean
    trustLevel?: number | null
}) {
    const q = (params.q || '').trim()
    const category = (params.category || '').trim()
    const sort = (params.sort || 'default').trim()
    const page = params.page && params.page > 0 ? params.page : 1
    const pageSize = Math.min(params.pageSize && params.pageSize > 0 ? params.pageSize : 24, 60)
    const offset = (page - 1) * pageSize

    const whereParts: any[] = [eq(products.isActive, true), visibilityCondition(params.isLoggedIn, params.trustLevel)]
    if (category && category !== 'all') whereParts.push(eq(products.category, category))
    if (q) {
        const like = `%${q}%`
        whereParts.push(or(
            sql`${products.name} LIKE ${like}`,
            sql`COALESCE(${products.description}, '') LIKE ${like}`
        ))
    }
    const whereExpr = and(...whereParts)

    const orderByParts: any[] = []
    switch (sort) {
        case 'priceAsc':
            orderByParts.push(asc(products.price))
            break
        case 'priceDesc':
            orderByParts.push(desc(products.price))
            break
        case 'stockDesc':
            orderByParts.push(desc(sql<number>`COALESCE(${products.stockCount}, 0) + COALESCE(${products.lockedCount}, 0)`))
            break
        case 'soldDesc':
            orderByParts.push(desc(sql<number>`COALESCE(${products.soldCount}, 0)`))
            break
        case 'hot':
            orderByParts.push(desc(sql<number>`case when ${products.isHot} = 1 then 1 else 0 end`))
            orderByParts.push(asc(products.sortOrder), desc(products.createdAt))
            break
        default:
            orderByParts.push(asc(products.sortOrder), desc(products.createdAt))
            break
    }

    const [rows] = await withProductColumnFallback(async () => {
        const rowsPromise = db.select({
            id: products.id,
            name: products.name,
            description: products.description,
            price: products.price,
            compareAtPrice: products.compareAtPrice,
            maxPointsDiscount: products.maxPointsDiscount,
            image: products.image,
            category: products.category,
            isHot: products.isHot,
            isShared: products.isShared,
            purchaseLimit: products.purchaseLimit,
            sortOrder: products.sortOrder,
            createdAt: products.createdAt,
            variantGroupId: products.variantGroupId,
            variantLabel: products.variantLabel,
            stock: sql<number>`COALESCE(${products.stockCount}, 0)`,
            locked: sql<number>`COALESCE(${products.lockedCount}, 0)`,
            sold: sql<number>`COALESCE(${products.soldCount}, 0)`,
            rating: sql<number>`COALESCE(${products.rating}, 0)`,
            reviewCount: sql<number>`COALESCE(${products.reviewCount}, 0)`
        })
            .from(products)
            .where(whereExpr)
            .orderBy(...orderByParts)

        return [await rowsPromise] as const
    })

    const grouped = groupProductsAsVariants(rows)
    const total = grouped.length
    const items = grouped.slice(offset, offset + pageSize)

    return {
        items,
        total,
        page,
        pageSize,
    }
}

export async function getActiveProductCategories(options?: { isLoggedIn?: boolean; trustLevel?: number | null }): Promise<string[]> {
    await ensureDatabaseReady();
    try {
        const rows = await db
            .select({ category: products.category })
            .from(products)
            .where(and(
                eq(products.isActive, true),
                visibilityCondition(options?.isLoggedIn, options?.trustLevel),
                sql`${products.category} IS NOT NULL`,
                sql`TRIM(${products.category}) <> ''`
            ))
            .groupBy(products.category)
            .orderBy(asc(products.category));
        return rows.map((r) => r.category as string).filter(Boolean);
    } catch (error: any) {
        if (isMissingTable(error)) return [];
        throw error;
    }
}

// Reviews
export async function getProductReviews(productId: string) {
    await ensureDatabaseReady()
    const reviewRows = await db.select()
        .from(reviews)
        .where(eq(reviews.productId, productId))
        .orderBy(desc(reviews.createdAt));

    if (!reviewRows.length) return reviewRows.map((review) => ({ ...review, replies: [] }));

    try {
        const replyRows = await db.select()
            .from(reviewReplies)
            .where(inArray(reviewReplies.reviewId, reviewRows.map((review) => review.id)))
            .orderBy(asc(reviewReplies.createdAt));

        const replyMap = new Map<number, typeof replyRows>()
        for (const reply of replyRows) {
            const list = replyMap.get(reply.reviewId) ?? []
            list.push(reply)
            replyMap.set(reply.reviewId, list)
        }

        return reviewRows.map((review) => ({
            ...review,
            replies: replyMap.get(review.id) ?? [],
        }));
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error;
        return reviewRows.map((review) => ({ ...review, replies: [] }));
    }
}

export async function getProductRating(productId: string): Promise<{ average: number; count: number }> {
    const result = await db.select({
        avg: sql<number>`COALESCE(AVG(${reviews.rating}), 0)`,
        count: sql<number>`COUNT(*)`
    })
        .from(reviews)
        .where(eq(reviews.productId, productId));

    return {
        average: result[0]?.avg ?? 0,
        count: result[0]?.count ?? 0
    };
}

export async function getProductRatings(productIds: string[]): Promise<Map<string, { average: number; count: number }>> {
    const map = new Map<string, { average: number; count: number }>();
    if (!productIds.length) return map;

    try {
        const rows = await db.select({
            productId: reviews.productId,
            avg: sql<number>`COALESCE(AVG(${reviews.rating}), 0)`,
            count: sql<number>`COUNT(*)`
        })
            .from(reviews)
            .where(inArray(reviews.productId, productIds))
            .groupBy(reviews.productId);

        for (const row of rows) {
            map.set(row.productId, {
                average: row.avg ?? 0,
                count: row.count ?? 0
            });
        }
    } catch (error: any) {
        if (!isMissingTable(error)) throw error;
    }

    return map;
}

export async function createReview(data: {
    productId: string;
    orderId: string;
    userId: string;
    username: string;
    rating: number;
    comment?: string;
}) {
    const res = await db.insert(reviews).values({
        ...data,
        createdAt: new Date()
    }).returning();

    // Update product aggregates (rating/review_count)
    await recalcProductAggregates(data.productId);

    return res;
}

export async function createReviewReply(data: {
    reviewId: number;
    userId: string;
    username: string;
    comment: string;
}) {
    await ensureDatabaseReady()
    return await db.insert(reviewReplies).values({
        ...data,
        createdAt: new Date(),
    }).returning();
}

export async function canUserReview(userId: string, productId: string, username?: string): Promise<{ canReview: boolean; orderId?: string }> {
    try {
        const findUnreviewedOrder = async (whereClause: any) => {
            const rows = await db.select({ orderId: orders.orderId })
                .from(orders)
                .leftJoin(reviews, eq(reviews.orderId, orders.orderId))
                .where(and(
                    whereClause,
                    eq(orders.productId, productId),
                    eq(orders.status, 'delivered'),
                    isNull(reviews.id)
                ))
                .orderBy(desc(normalizeTimestampMs(orders.createdAt)))
                .limit(1);
            return rows[0]?.orderId;
        };

        // Prefer userId; only fallback to username when userId has no delivered orders.
        const byUserIdOrderId = await findUnreviewedOrder(eq(orders.userId, userId));
        if (byUserIdOrderId) {
            return { canReview: true, orderId: byUserIdOrderId };
        }

        const hasDeliveredByUserId = await db.select({ orderId: orders.orderId })
            .from(orders)
            .where(and(
                eq(orders.userId, userId),
                eq(orders.productId, productId),
                eq(orders.status, 'delivered')
            ))
            .limit(1);
        if (hasDeliveredByUserId.length > 0) {
            return { canReview: false };
        }

        if (!username) {
            return { canReview: false };
        }

        const byUsernameOrderId = await findUnreviewedOrder(eq(orders.username, username));
        if (byUsernameOrderId) {
            return { canReview: true, orderId: byUsernameOrderId };
        }

        return { canReview: false };
    } catch (error) {
        console.error('canUserReview error:', error);
        return { canReview: false };
    }
}

export async function hasUserReviewedOrder(orderId: string): Promise<boolean> {
    const result = await db.select({ id: reviews.id })
        .from(reviews)
        .where(eq(reviews.orderId, orderId));
    return result.length > 0;
}

function isMissingTable(error: any) {
    const errorString = (JSON.stringify(error) + String(error) + (error?.message || '')).toLowerCase();
    return (
        error?.message?.includes('does not exist') ||
        error?.cause?.message?.includes('does not exist') ||
        errorString.includes('42p01') ||
        errorString.includes('no such table') ||
        (errorString.includes('relation') && errorString.includes('does not exist'))
    );
}

function isMissingTableOrColumn(error: any) {
    const errorString = (JSON.stringify(error) + String(error) + (error?.message || '')).toLowerCase();
    return isMissingTable(error) || errorString.includes('42703') || errorString.includes('no such column') || errorString.includes('column not found') || errorString.includes('d1_column_notfound');
}

const TIMESTAMP_MS_THRESHOLD = 1_000_000_000_000;

export function normalizeTimestampMs(column: any) {
    return sql<number>`CASE WHEN ${column} < ${TIMESTAMP_MS_THRESHOLD} THEN ${column} * 1000 ELSE ${column} END`
}


function isInvalidGitHubPlaceholderUser(userId?: string | null, username?: string | null) {
    const normalizedUserId = (userId || '').trim().toLowerCase()
    const normalizedUsername = (username || '').trim().toLowerCase()

    return (
        normalizedUserId === 'github:undefined' ||
        normalizedUserId === 'github:null' ||
        normalizedUserId === 'github:nan' ||
        normalizedUsername === 'gh_undefined' ||
        normalizedUsername === 'gh_null' ||
        normalizedUsername === 'gh_nan'
    )
}

export async function recordLoginUser(userId: string, username?: string | null, email?: string | null) {
    if (!userId || isInvalidGitHubPlaceholderUser(userId, username)) return;
    await ensureDatabaseReady();
    await db.insert(loginUsers).values({
        userId, username: username || null, email: email || null, lastLoginAt: new Date(),
    }).onConflictDoUpdate({
        target: loginUsers.userId,
        set: {
            username: username || null,
            lastLoginAt: new Date(),
            email: sql`CASE WHEN ${loginUsers.email} IS NULL OR ${loginUsers.email} = '' THEN ${email || null} ELSE ${loginUsers.email} END`,
        },
    });
}

export async function getLoginUserEmail(userId: string): Promise<string | null> {
    if (!userId) return null;
    try {
        const result = await db.select({ email: loginUsers.email })
            .from(loginUsers)
            .where(eq(loginUsers.userId, userId))
            .limit(1);
        return result[0]?.email ?? null;
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return null;
        throw error;
    }
}

export async function updateLoginUserEmail(userId: string, email: string | null) {
    if (!userId) return;
    try {
        await ensureDatabaseReady();
        await db.update(loginUsers)
            .set({ email: email || null, lastLoginAt: new Date() })
            .where(eq(loginUsers.userId, userId));
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return;
        throw error;
    }
}

export async function getLoginUserDesktopNotificationsEnabled(userId: string): Promise<boolean> {
    if (!userId) return false;
    try {
        const result = await db.select({ enabled: loginUsers.desktopNotificationsEnabled })
            .from(loginUsers)
            .where(eq(loginUsers.userId, userId))
            .limit(1);
        return Boolean(result[0]?.enabled);
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return false;
        throw error;
    }
}

export async function updateLoginUserDesktopNotificationsEnabled(userId: string, enabled: boolean) {
    if (!userId) return;
    try {
        await ensureDatabaseReady();
        await db.update(loginUsers)
            .set({ desktopNotificationsEnabled: enabled, lastLoginAt: new Date() })
            .where(eq(loginUsers.userId, userId));
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return;
        throw error;
    }
}

let lastGlobalCardCleanupAt = 0;

export async function cleanupExpiredCardsIfNeeded(throttleMs: number = 10 * 60 * 1000, productId?: string) {
    const now = Date.now();
    if (!productId && now - lastGlobalCardCleanupAt < throttleMs) return false;
    await ensureDatabaseReady();
    const condition = and(
        sql`${cards.expiresAt} IS NOT NULL AND ${cards.expiresAt} < ${now}`,
        productId ? eq(cards.productId, productId) : undefined,
    );
    const rows = await db.selectDistinct({ productId: cards.productId }).from(cards).where(condition);
    if (!rows.length) {
        if (!productId) lastGlobalCardCleanupAt = now;
        return false;
    }
    await db.delete(cards).where(condition);
    await recalcProductAggregatesForMany(rows.map(row => row.productId));
    if (!productId) lastGlobalCardCleanupAt = now;
    try {
        updateTag('home:products');
        updateTag('home:product-categories');
    } catch {
        // Cron runs outside Server Actions.
    }
    return true;
}

export async function getVisitorCount(): Promise<number> {
    return visitorCountCache.get(async () => {
        await ensureDatabaseReady();
        const result = await db.select({ count: sql<number>`count(*)` }).from(loginUsers);
        return Number(result[0]?.count || 0);
    });
}

export async function cancelExpiredOrders(filters: { productId?: string; userId?: string; orderId?: string } = {}) {
    const productId = filters.productId ?? null;
    const userId = filters.userId ?? null;
    const orderId = filters.orderId ?? null;

    try {
        await Promise.all([
            ensureDatabaseReady(),
            ensureDatabaseReady(),
        ])
    } catch (error: any) {
        if (!isMissingTableOrColumn(error)) throw error
    }

    try {
        // No transaction - D1 doesn't support SQL transactions
        const fiveMinutesAgoMs = Date.now() - RESERVATION_TTL_MS;
        // Preselect expired orders because D1 may not return rows for UPDATE ... RETURNING
        const candidates = await db
            .select({ orderId: orders.orderId, productId: orders.productId })
            .from(orders)
            .where(and(
                eq(orders.status, 'pending'),
                lt(orders.createdAt, new Date(fiveMinutesAgoMs)),
                productId ? eq(orders.productId, productId) : sql`1=1`,
                userId ? eq(orders.userId, userId) : sql`1=1`,
                orderId ? eq(orders.orderId, orderId) : sql`1=1`
            ));

        const orderIds = candidates.map((row) => row.orderId).filter(Boolean);
        if (!orderIds.length) return orderIds;

        for (const expired of candidates) {
            const expiredOrderId = expired.orderId;
            if (!expiredOrderId) continue;
            try {
                // Mirror manual cancel behavior to guarantee release
                await db.update(cards)
                    .set({ reservedOrderId: null, reservedAt: null })
                    .where(eq(cards.reservedOrderId, expiredOrderId));
            } catch (error: any) {
                if (!isMissingTableOrColumn(error)) throw error;
            }
            await db.update(orders)
                .set({ status: 'cancelled' })
                .where(eq(orders.orderId, expiredOrderId));
        }

        const productIds = Array.from(new Set(candidates.map((row) => row.productId).filter(Boolean)));
        for (const pid of productIds) {
            try {
                await recalcProductAggregates(pid);
            } catch {
                // best effort
            }
        }
        try {
            updateTag('home:products');
            updateTag('home:product-categories');
        } catch {
            // best effort
        }
        try {
            revalidatePath('/orders');
            revalidatePath('/admin/orders');
            for (const expired of candidates) {
                if (expired.orderId) {
                    revalidatePath(`/order/${expired.orderId}`);
                }
            }
        } catch {
            // best effort
        }

        return orderIds;
    } catch (error: any) {
        if (isMissingTableOrColumn(error)) return [];
        throw error;
    }
}

// Customer Management
export async function getUsers(page = 1, pageSize = 20, q = '') {
    const offset = (page - 1) * pageSize
    const search = q.trim()

    try {
        await ensureDatabaseReady();

        let whereClause = undefined
        if (search) {
            const like = `%${search}%`
            whereClause = or(
                sql`${loginUsers.username} LIKE ${like}`,
                sql`${loginUsers.userId} LIKE ${like}`
            )
        }

        const itemsPromise = db.select({
            userId: loginUsers.userId,
            username: loginUsers.username,
            points: loginUsers.points,
            isBlocked: sql<boolean>`COALESCE(${loginUsers.isBlocked}, FALSE)`,
            lastLoginAt: loginUsers.lastLoginAt,
            createdAt: loginUsers.createdAt,
            orderCount: sql<number>`count(CASE WHEN ${orders.status} IN ('paid', 'delivered', 'refunded') THEN 1 END)`
        })
            .from(loginUsers)
            .leftJoin(orders, eq(loginUsers.userId, orders.userId))
            .where(whereClause)
            .groupBy(loginUsers.userId)
            .orderBy(desc(loginUsers.lastLoginAt))
            .limit(pageSize)
            .offset(offset)

        const countQuery = db.select({ count: sql<number>`count(DISTINCT ${loginUsers.userId})` })
            .from(loginUsers)
            .where(whereClause)

        const [items, totalRes] = await Promise.all([itemsPromise, countQuery])

        return {
            items,
            total: totalRes[0]?.count || 0,
            page,
            pageSize
        }
    } catch (error: any) {
        if (isMissingTable(error)) {
            return { items: [], total: 0, page, pageSize }
        }
        throw error
    }
}

export async function updateUserPoints(userId: string, points: number) {
    await ensureDatabaseReady();
    await db.update(loginUsers)
        .set({ points })
        .where(eq(loginUsers.userId, userId));
}

export async function toggleUserBlock(userId: string, isBlocked: boolean) {
    await ensureDatabaseReady();

    await db.update(loginUsers)
        .set({ isBlocked })
        .where(eq(loginUsers.userId, userId));
}

export async function getUserPendingOrders(userId: string) {
    return await db.select({
        orderId: orders.orderId,
        createdAt: orders.createdAt,
        productName: orders.productName,
        amount: orders.amount
    })
        .from(orders)
        .where(and(
            eq(orders.userId, userId),
            eq(orders.status, 'pending')
        ))
        .orderBy(desc(normalizeTimestampMs(orders.createdAt)));
}
