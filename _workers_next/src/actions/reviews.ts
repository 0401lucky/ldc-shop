'use server'
import { ensureDatabaseReady } from "@/lib/db/ready"

import { auth } from '@/lib/auth'
import { createReview, createReviewReply } from '@/lib/db/queries'
import { db } from '@/lib/db'
import { orders, reviews } from '@/lib/db/schema'
import { eq, sql } from 'drizzle-orm'
import { revalidatePath, updateTag } from 'next/cache'

export async function submitReview(
    productId: string,
    orderId: string,
    rating: number,
    comment: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await auth()
        if (!session?.user) {
            return { success: false, error: 'review.authRequired' }
        }

        // Validate rating
        if (rating < 1 || rating > 5) {
            return { success: false, error: 'review.invalidRating' }
        }

        const order = await db.query.orders.findFirst({
            where: eq(orders.orderId, orderId),
            columns: {
                userId: true,
                username: true,
                status: true,
                productId: true
            }
        })

        if (!order) {
            return { success: false, error: 'review.orderNotFound' }
        }

        if (order.productId !== productId) {
            return { success: false, error: 'review.invalidOrder' }
        }

        const sessionUsername = session.user.username || session.user.name || ''
        const isOwner =
            (order.userId && order.userId === session.user.id) ||
            (order.username && sessionUsername && order.username === sessionUsername)

        if (!isOwner) {
            return { success: false, error: 'review.notOwner' }
        }

        if (order.status !== 'delivered') {
            return { success: false, error: 'review.orderNotDelivered' }
        }

        // Ensure reviews table exists
        await ensureDatabaseReady()

        // Check if already reviewed (now table definitely exists)
        const existingReview = await db.run(sql`
            SELECT id FROM reviews WHERE order_id = ${orderId} LIMIT 1
        `)
        if (existingReview.results && existingReview.results.length > 0) {
            return { success: false, error: 'review.alreadyReviewed' }
        }
        if (existingReview.rows && existingReview.rows.length > 0) {
            return { success: false, error: 'review.alreadyReviewed' }
        }

        // Create review
        await createReview({
            productId,
            orderId,
            userId: session.user.id || '',
            username: session.user.username || session.user.name || 'Anonymous',
            rating,
            comment: comment || undefined
        })

        revalidatePath(`/buy/${productId}`)
        revalidatePath(`/order/${orderId}`)
        revalidatePath(`/`)
        updateTag('home:ratings')
        updateTag('home:products')

        return { success: true }
    } catch (error) {
        console.error('Failed to submit review:', error)
        return { success: false, error: 'review.submitError' }
    }
}

export async function submitReviewReply(
    reviewId: number,
    productId: string,
    comment: string
): Promise<{ success: boolean; error?: string }> {
    try {
        const session = await auth()
        if (!session?.user) {
            return { success: false, error: 'review.authRequired' }
        }

        const normalizedComment = comment.trim()
        if (!normalizedComment) {
            return { success: false, error: 'review.replyEmpty' }
        }
        if (normalizedComment.length > 1000) {
            return { success: false, error: 'review.replyTooLong' }
        }

        await ensureDatabaseReady()

        const review = await db.query.reviews.findFirst({
            where: eq(reviews.id, reviewId),
            columns: {
                id: true,
                productId: true,
            }
        })

        if (!review || review.productId !== productId) {
            return { success: false, error: 'review.replyInvalidReview' }
        }

        await createReviewReply({
            reviewId,
            userId: session.user.id || '',
            username: session.user.username || session.user.name || 'Anonymous',
            comment: normalizedComment,
        })

        revalidatePath(`/buy/${productId}`)
        revalidatePath(`/`)
        updateTag('home:ratings')
        updateTag('home:products')

        return { success: true }
    } catch (error) {
        console.error('Failed to submit review reply:', error)
        return { success: false, error: 'review.replySubmitError' }
    }
}
