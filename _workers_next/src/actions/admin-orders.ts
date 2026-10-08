'use server'
import { ensureDatabaseReady } from "@/lib/db/ready"

import { db } from "@/lib/db"
import { cards, orders, refundRequests, loginUsers } from "@/lib/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { revalidatePath, updateTag } from "next/cache"
import { checkAdmin } from "@/actions/admin"
import { recalcProductAggregates, recalcProductAggregatesForMany, createUserNotification } from "@/lib/db/queries"
import { pullOneCardFromApi } from "@/lib/card-api"

export async function markOrderPaid(orderId: string) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")

  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true } })
  await db.update(orders).set({
    status: 'paid',
    paidAt: new Date(),
  }).where(eq(orders.orderId, orderId))

  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath(`/order/${orderId}`)
  if (order?.productId) {
    try {
      await recalcProductAggregates(order.productId)
    } catch {
      // best effort
    }
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

export async function markOrderDelivered(orderId: string) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")

  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
  if (!order) throw new Error("Order not found")
  if (!order.cardKey) throw new Error("Missing card key; cannot mark delivered")

  await db.update(orders).set({
    status: 'delivered',
    deliveredAt: new Date(),
  }).where(eq(orders.orderId, orderId))

  if (order.userId) {
    await createUserNotification({
      userId: order.userId,
      type: 'order_delivered',
      titleKey: 'profile.notifications.orderDeliveredTitle',
      contentKey: 'profile.notifications.orderDeliveredBody',
      data: {
        params: {
          orderId: order.orderId,
          productName: order.productName || 'Product'
        },
        href: `/order/${order.orderId}`
      }
    })
  }

  if (order.productId && order.cardIds) {
    try {
      const result = await pullOneCardFromApi(order.productId)
      if (result.ok) {
        console.log(`[Card API] Auto replenished for product ${order.productId}, reason=admin_mark_delivered:${orderId}`)
      } else if (result.skipped) {
        console.info(`[Card API] Auto replenish skipped for product ${order.productId}, reason=admin_mark_delivered:${orderId}, detail=${result.error || "skipped"}`)
      } else {
        console.warn(`[Card API] Auto replenish failed for product ${order.productId}, reason=admin_mark_delivered:${orderId}, detail=${result.error || "unknown_error"}`)
      }
    } catch (error: any) {
      console.warn(`[Card API] Auto replenish exception for product ${order.productId}, reason=admin_mark_delivered:${orderId}, detail=${error?.message || "unknown_error"}`)
    }
  }

  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath(`/order/${orderId}`)
  if (order?.productId) {
    try {
      await recalcProductAggregates(order.productId)
    } catch {
      // best effort
    }
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

export async function cancelOrder(orderId: string) {
  await checkAdmin()
  await ensureDatabaseReady()
  if (!orderId) throw new Error("Missing order id")

  // No transaction - D1 doesn't support SQL transactions
  // 1. Refund points if used
  const order = await db.query.orders.findFirst({
    where: eq(orders.orderId, orderId),
    columns: { userId: true, pointsUsed: true, productId: true }
  })

  if (order?.userId && order.pointsUsed && order.pointsUsed > 0) {
    await db.update(loginUsers)
      .set({ points: sql`${loginUsers.points} + ${order.pointsUsed}` })
      .where(eq(loginUsers.userId, order.userId))
  }

  await db.update(orders).set({ status: 'cancelled' }).where(eq(orders.orderId, orderId))
  await db.update(cards).set({ reservedOrderId: null, reservedAt: null })
    .where(sql`${cards.reservedOrderId} = ${orderId} AND ${cards.isUsed} = false`)

  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
  revalidatePath(`/order/${orderId}`)
  if (order?.productId) {
    try {
      await recalcProductAggregates(order.productId)
    } catch {
      // best effort
    }
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

export async function updateOrderEmail(orderId: string, email: string | null) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")
  const next = (email || '').trim()
  await db.update(orders).set({ email: next || null }).where(eq(orders.orderId, orderId))
  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
}

async function deleteOneOrder(orderId: string) {
  await ensureDatabaseReady()
  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId) })
  if (!order) return

  // Refund points if used
  if (order.userId && order.pointsUsed && order.pointsUsed > 0) {
    await db.update(loginUsers)
      .set({ points: sql`${loginUsers.points} + ${order.pointsUsed}` })
      .where(eq(loginUsers.userId, order.userId))
  }

  // Release reserved card if any

  await db.update(cards).set({ reservedOrderId: null, reservedAt: null })
    .where(sql`${cards.reservedOrderId} = ${orderId} AND ${cards.isUsed} = false`)

  // Delete related refund requests (best effort)
  try {
    await db.delete(refundRequests).where(eq(refundRequests.orderId, orderId))
  } catch {
    // table may not exist yet
  }

  await db.delete(orders).where(eq(orders.orderId, orderId))
}

export async function deleteOrder(orderId: string) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")

  const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true } })
  await deleteOneOrder(orderId)

  revalidatePath('/admin/orders')
  revalidatePath(`/admin/orders/${orderId}`)
  if (order?.productId) {
    try {
      await recalcProductAggregates(order.productId)
    } catch {
      // best effort
    }
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

export async function deleteOrders(orderIds: string[]) {
  await checkAdmin()
  const ids = (orderIds || []).map((s) => String(s).trim()).filter(Boolean)
  if (!ids.length) return

  const touchedProducts: string[] = []

  for (const id of ids) {
    const order = await db.query.orders.findFirst({ where: eq(orders.orderId, id), columns: { productId: true } })
    if (order?.productId) touchedProducts.push(order.productId)
    await deleteOneOrder(id)
  }

  revalidatePath('/admin/orders')
  try {
    await recalcProductAggregatesForMany(touchedProducts)
  } catch {
    // best effort
  }
  try {
    updateTag('home:products')
  } catch {
    // best effort
  }
}

import { queryOrderStatus } from "@/lib/epay"

export async function verifyOrderRefundStatus(orderId: string) {
  await checkAdmin()
  if (!orderId) throw new Error("Missing order id")

  try {
    const result = await queryOrderStatus(orderId)

    if (result.success) {
      // status 0 = Refunded
      if (result.status === 0) {
        const order = await db.query.orders.findFirst({ where: eq(orders.orderId, orderId), columns: { productId: true } })
        await db.update(orders).set({ status: 'refunded' }).where(eq(orders.orderId, orderId))
        revalidatePath('/admin/orders')
        if (order?.productId) {
          try {
            await recalcProductAggregates(order.productId)
          } catch {
            // best effort
          }
        }
        try {
          updateTag('home:products')
        } catch {
          // best effort
        }
        return { success: true, status: result.status, msg: 'Refunded (Verified)' }
      } else if (result.status === 1) {
        return { success: true, status: result.status, msg: 'Paid (Not Refunded)' }
      } else {
        return { success: true, status: result.status, msg: `Status: ${result.status}` }
      }
    } else {
      return { success: false, error: result.error }
    }

  } catch (e: any) {
    console.error('Verify refund error', e)
    return { success: false, error: e.message }
  }
}
