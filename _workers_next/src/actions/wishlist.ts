"use server"
import { ensureDatabaseReady } from "@/lib/db/ready"

import { auth } from "@/lib/auth"
import { db } from "@/lib/db"
import { loginUsers } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { revalidatePath } from "next/cache"
import { getSetting } from "@/lib/db/queries"

async function isBlockedUser(userId: string) {
    try {
        const rows = await db.select({ isBlocked: loginUsers.isBlocked })
            .from(loginUsers)
            .where(eq(loginUsers.userId, userId))
            .limit(1)
        return !!rows[0]?.isBlocked
    } catch {
        return false
    }
}

export async function submitWishlistItem(title: string, description?: string) {
    const session = await auth()
    const userId = session?.user?.id
    const username = session?.user?.username || session?.user?.name || null
    if (!userId) {
        return { success: false, error: "wishlist.loginRequired" }
    }
    try {
        const enabled = await getSetting('wishlist_enabled')
        if (enabled !== 'true') {
            return { success: false, error: "wishlist.disabled" }
        }
    } catch {
        return { success: false, error: "wishlist.disabled" }
    }
    if (await isBlockedUser(userId)) {
        return { success: false, error: "wishlist.blocked" }
    }

    const cleanTitle = (title || "").trim()
    const cleanDesc = (description || "").trim()
    if (!cleanTitle) {
        return { success: false, error: "wishlist.titleRequired" }
    }
    if (cleanTitle.length > 80) {
        return { success: false, error: "wishlist.titleTooLong" }
    }
    if (cleanDesc.length > 300) {
        return { success: false, error: "wishlist.descTooLong" }
    }

    await ensureDatabaseReady()
    const result: any = await db.run(sql`
        INSERT INTO wishlist_items (title, description, user_id, username, created_at)
        VALUES (${cleanTitle}, ${cleanDesc || null}, ${userId}, ${username}, (unixepoch() * 1000))
        RETURNING id
    `)
    const rows = result?.results || result?.rows || []
    let id = Number(rows[0]?.id || 0)

    // Fallback to meta.last_row_id if RETURNING didn't work (older D1 behavior)
    if (!id && result?.meta?.last_row_id) {
        id = Number(result.meta.last_row_id)
    }

    revalidatePath("/")
    revalidatePath("/wishlist")

    return {
        success: true,
        item: {
            id,
            title: cleanTitle,
            description: cleanDesc || null,
            username,
            createdAt: Date.now(),
            votes: 0,
            voted: false
        }
    }
}

export async function toggleWishlistVote(itemId: number) {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) {
        return { success: false, error: "wishlist.loginRequired" }
    }
    try {
        const enabled = await getSetting('wishlist_enabled')
        if (enabled !== 'true') {
            return { success: false, error: "wishlist.disabled" }
        }
    } catch {
        return { success: false, error: "wishlist.disabled" }
    }
    if (await isBlockedUser(userId)) {
        return { success: false, error: "wishlist.blocked" }
    }
    const id = Number(itemId)
    if (!id) {
        return { success: false, error: "wishlist.invalidItem" }
    }

    await ensureDatabaseReady()

    const existing: any = await db.run(sql`
        SELECT id FROM wishlist_votes
        WHERE item_id = ${id} AND user_id = ${userId}
        LIMIT 1
    `)
    const existingRows = existing?.results || existing?.rows || []
    const hasVote = existingRows.length > 0

    if (hasVote) {
        await db.run(sql`
            DELETE FROM wishlist_votes
            WHERE item_id = ${id} AND user_id = ${userId}
        `)
    } else {
        await db.run(sql`
            INSERT OR IGNORE INTO wishlist_votes (item_id, user_id, created_at)
            VALUES (${id}, ${userId}, (unixepoch() * 1000))
        `)
    }

    const countResult: any = await db.run(sql`
        SELECT COUNT(*) AS count FROM wishlist_votes WHERE item_id = ${id}
    `)
    const countRows = countResult?.results || countResult?.rows || []
    const count = Number(countRows[0]?.count || 0)

    revalidatePath("/")
    revalidatePath("/wishlist")

    return { success: true, voted: !hasVote, count }
}

export async function deleteWishlistItem(id: number) {
    const { checkAdmin } = await import("./admin")
    await checkAdmin()

    await db.run(sql`
        DELETE FROM wishlist_items WHERE id = ${id}
    `)

    revalidatePath("/")
    revalidatePath("/wishlist")
    return { success: true }
}
