"use server"
import { ensureDatabaseReady } from "@/lib/db/ready"

import { db } from "@/lib/db"
import { userMessages, loginUsers } from "@/lib/db/schema"
import { eq, sql } from "drizzle-orm"
import { auth } from "@/lib/auth"
import { checkAdmin } from "@/actions/admin"
import { revalidatePath } from "next/cache"
import { notifyAdminUserMessage } from "@/lib/notifications"

export async function sendUserMessage(title: string, body: string) {
    const session = await auth()
    const userId = session?.user?.id
    const username = session?.user?.username || session?.user?.name || null
    if (!userId) {
        return { success: false, error: "Unauthorized" }
    }

    try {
        const rows = await db.select({ isBlocked: loginUsers.isBlocked })
            .from(loginUsers)
            .where(eq(loginUsers.userId, userId))
            .limit(1)
        if (rows[0]?.isBlocked) {
            return { success: false, error: "profile.messages.blocked" }
        }
    } catch {
        // ignore if table/column not available yet
    }

    const cleanTitle = (title || '').trim()
    const cleanBody = (body || '').trim()
    if (!cleanTitle || !cleanBody) {
        return { success: false, error: "profile.messages.missing" }
    }

    await ensureDatabaseReady()
    await db.insert(userMessages).values({
        userId,
        username,
        title: cleanTitle.slice(0, 120),
        body: cleanBody.slice(0, 2000),
        isRead: false,
        createdAt: new Date()
    })

    try {
        await notifyAdminUserMessage({
            userId,
            username,
            title: cleanTitle.slice(0, 120),
            body: cleanBody.slice(0, 2000)
        })
    } catch (error) {
        console.error("[UserMessage] notify admin failed:", error)
    }

    revalidatePath("/admin/messages")
    return { success: true }
}

export async function getUnreadUserMessageCount() {
    await checkAdmin()
    await ensureDatabaseReady()
    const rows = await db.select({ count: sql<number>`count(*)` })
        .from(userMessages)
        .where(eq(userMessages.isRead, false))
    return { success: true, count: Number(rows[0]?.count || 0) }
}

export async function markUserMessageRead(id: number) {
    await checkAdmin()
    await ensureDatabaseReady()
    await db.update(userMessages).set({ isRead: true }).where(eq(userMessages.id, id))
    revalidatePath("/admin/messages")
    return { success: true }
}

export async function deleteUserMessage(id: number) {
    await checkAdmin()
    await ensureDatabaseReady()
    await db.delete(userMessages).where(eq(userMessages.id, id))
    revalidatePath("/admin/messages")
    return { success: true }
}

export async function clearMyMessages() {
    const session = await auth()
    const userId = session?.user?.id
    if (!userId) return { success: false, error: "Unauthorized" }

    await ensureDatabaseReady()
    await db.delete(userMessages).where(eq(userMessages.userId, userId))
    return { success: true }
}

export async function clearUserMessages() {
    await checkAdmin()
    await ensureDatabaseReady()
    await db.delete(userMessages)
    revalidatePath("/admin/messages")
    return { success: true }
}
