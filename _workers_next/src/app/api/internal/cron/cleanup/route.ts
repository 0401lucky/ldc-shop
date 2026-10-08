import { NextResponse } from "next/server";
import { cancelExpiredOrders, cleanupExpiredCardsIfNeeded } from "@/lib/db/queries";

const CRON_TOKEN_HEADER = "x-cron-cleanup-token";
const CARD_CLEANUP_INTERVAL_MINUTES = 10;

function getCronToken(): string | null {
    const token = process.env.CRON_CLEANUP_TOKEN?.trim();
    if (token) return token;
    const oauthSecret = process.env.OAUTH_CLIENT_SECRET?.trim();
    return oauthSecret || null;
}

function isAuthorized(request: Request, expectedToken: string): boolean {
    const received = request.headers.get(CRON_TOKEN_HEADER)?.trim();
    return !!received && received === expectedToken;
}

export async function POST(request: Request) {
    const expectedToken = getCronToken();
    if (!expectedToken) {
        return NextResponse.json(
            { success: false, error: "cleanup_token_not_configured" },
            { status: 500 }
        );
    }

    if (!isAuthorized(request, expectedToken)) {
        return NextResponse.json(
            { success: false, error: "unauthorized" },
            { status: 401 }
        );
    }

    const startedAt = Date.now();
    // Expired cards are excluded by stock queries immediately. Physical deletion
    // can run less often; order reservation cleanup still runs every minute.
    const cleanCards = new Date(startedAt).getUTCMinutes() % CARD_CLEANUP_INTERVAL_MINUTES === 0;
    const [cardsResult, ordersResult] = await Promise.allSettled([
        cleanCards ? cleanupExpiredCardsIfNeeded() : Promise.resolve(false),
        cancelExpiredOrders(),
    ]);

    const durationMs = Date.now() - startedAt;

    if (cardsResult.status === "rejected" || ordersResult.status === "rejected") {
        console.error("[cron-cleanup] failed", {
            cardsError: cardsResult.status === "rejected" ? String(cardsResult.reason) : null,
            ordersError: ordersResult.status === "rejected" ? String(ordersResult.reason) : null,
        });

        return NextResponse.json(
            { success: false, error: "cleanup_failed", durationMs },
            { status: 500 }
        );
    }

    return NextResponse.json({
        success: true,
        durationMs,
        cardsCleanupRan: cardsResult.value,
        cancelledOrderCount: ordersResult.value.length,
    });
}
