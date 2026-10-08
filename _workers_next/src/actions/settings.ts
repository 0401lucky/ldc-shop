'use server'
import { ensureDatabaseReady } from "@/lib/db/ready"

import { setSetting, getSetting } from "@/lib/db/queries"
import { revalidatePath, updateTag } from "next/cache"
import { checkAdmin } from "@/actions/admin"

export type AnnouncementConfig = {
    content: string
    startAt?: string | null
    endAt?: string | null
    popupEnabled?: boolean
    popupTitle?: string | null
    popupContent?: string | null
    updatedAt?: string | null
}

function parseAnnouncement(raw: string | null): AnnouncementConfig | null {
    if (!raw) return null
    const text = String(raw)
    try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object') {
            return {
                content: typeof parsed.content === 'string' ? parsed.content : '',
                startAt: typeof parsed.startAt === 'string' ? parsed.startAt : null,
                endAt: typeof parsed.endAt === 'string' ? parsed.endAt : null,
                popupEnabled: parsed.popupEnabled === true,
                popupTitle: typeof parsed.popupTitle === 'string' ? parsed.popupTitle : null,
                popupContent: typeof parsed.popupContent === 'string' ? parsed.popupContent : null,
                updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
            }
        }
    } catch {
        // fall through
    }
    return {
        content: text,
        startAt: null,
        endAt: null,
        popupEnabled: false,
        popupTitle: null,
        popupContent: null,
        updatedAt: null,
    }
}

function isInTimeWindow(cfg: AnnouncementConfig, now: Date): boolean {
    const startOk = cfg.startAt ? now >= new Date(cfg.startAt) : true
    const endOk = cfg.endAt ? now <= new Date(cfg.endAt) : true
    return startOk && endOk
}

export type ActiveAnnouncement = {
    banner: string | null
    popup: {
        title: string | null
        content: string
        signature: string
    } | null
}

export async function saveAnnouncement(config: AnnouncementConfig) {
    await checkAdmin()

    const content = String(config.content || '')
    const startAt = config.startAt ? String(config.startAt) : null
    const endAt = config.endAt ? String(config.endAt) : null
    const popupEnabled = config.popupEnabled === true
    const popupTitle = config.popupTitle ? String(config.popupTitle) : null
    const popupContent = config.popupContent ? String(config.popupContent) : null
    const updatedAt = new Date().toISOString()

    const payload = JSON.stringify({ content, startAt, endAt, popupEnabled, popupTitle, popupContent, updatedAt })
    try {
        await setSetting('announcement', payload)
    } catch (error: any) {
        // If settings table doesn't exist, create it
        if (error.message?.includes('does not exist') ||
            error.code === '42P01' ||
            JSON.stringify(error).includes('42P01')) {
            await ensureDatabaseReady()
            // Retry the insert
            await setSetting('announcement', payload)
        } else {
            throw error
        }
    }
    revalidatePath('/')
    revalidatePath('/admin/announcement')
    updateTag('home:announcement')
    return { success: true }
}

export async function getAnnouncementConfig(): Promise<AnnouncementConfig | null> {
    try {
        const raw = await getSetting('announcement')
        return parseAnnouncement(raw)
    } catch {
        return null
    }
}

export async function getActiveAnnouncement(now: Date = new Date()): Promise<ActiveAnnouncement | null> {
    const cfg = await getAnnouncementConfig()
    if (!cfg || !isInTimeWindow(cfg, now)) return null

    const banner = cfg.content?.trim() ? cfg.content : null
    const popupContent = cfg.popupEnabled && cfg.popupContent?.trim() ? cfg.popupContent : null

    if (!banner && !popupContent) return null

    return {
        banner,
        popup: popupContent ? {
            title: cfg.popupTitle?.trim() ? cfg.popupTitle : null,
            content: popupContent,
            signature: JSON.stringify({
                title: cfg.popupTitle || '',
                content: popupContent,
                startAt: cfg.startAt || '',
                endAt: cfg.endAt || '',
                updatedAt: cfg.updatedAt || '',
            }),
        } : null,
    }
}
