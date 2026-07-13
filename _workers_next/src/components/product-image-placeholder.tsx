"use client"

import { Box, Gift, Package, ShoppingBag } from "lucide-react"

const ICONS = [Package, Box, Gift, ShoppingBag] as const
/* Nature-leaning palette: clover, mint, teal, lime, soft gold, soft rose */
const HUES = [145, 160, 175, 120, 95, 20] as const

function hash(str: string): number {
    let h = 0
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h + str.charCodeAt(i)) | 0
    }
    return h
}

interface ProductImagePlaceholderProps {
    productId: string
    productName: string
    size?: "xs" | "sm" | "md"
    className?: string
    fill?: boolean
}

export function ProductImagePlaceholder({ productId, productName, size = "sm", className, fill = false }: ProductImagePlaceholderProps) {
    const h = hash(productId)
    const hue = HUES[Math.abs(h) % HUES.length]
    const Icon = ICONS[Math.abs(h >> 8) % ICONS.length]
    const boxSize = fill
        ? size === "xs"
            ? "h-16 w-16"
            : size === "sm"
                ? "h-28 w-28 sm:h-32 sm:w-32"
                : "h-36 w-36 md:h-44 md:w-44"
        : size === "xs"
            ? "h-12 w-12"
            : size === "sm"
                ? "h-20 w-20"
                : "h-28 w-28"
    const iconSize = fill
        ? size === "xs"
            ? "h-6 w-6"
            : size === "sm"
                ? "h-14 w-14 sm:h-16 sm:w-16"
                : "h-20 w-20 md:h-24 md:w-24"
        : size === "xs"
            ? "h-5 w-5"
            : size === "sm"
                ? "h-9 w-9"
                : "h-14 w-14"
    const rounded = size === "xs" ? "rounded-lg" : size === "sm" ? "rounded-3xl" : "rounded-[2rem]"

    return (
        <div className={`flex h-full w-full items-center justify-center ${className ?? ""}`} role="img" aria-label={productName || "Product"}>
            <div
                className={`relative flex ${boxSize} items-center justify-center ${rounded} shadow-inner ring-1 ring-black/5 dark:ring-white/10`}
                style={{
                    background: `linear-gradient(135deg, oklch(0.94 0.04 ${hue}), oklch(0.88 0.06 ${hue}))`,
                }}
            >
                <Icon
                    className={`${iconSize} opacity-55`}
                    strokeWidth={1.5}
                    style={{ color: `oklch(0.5 0.2 ${hue})` }}
                />
                {size !== "xs" && (
                    <div
                        className="pointer-events-none absolute -right-3 -top-3 h-8 w-8 rounded-full blur-lg opacity-40"
                        style={{ background: `oklch(0.6 0.15 ${hue})` }}
                    />
                )}
                {size === "md" && (
                    <div
                        className="pointer-events-none absolute -bottom-3 -left-3 h-10 w-10 rounded-full blur-xl opacity-30"
                        style={{ background: `oklch(0.65 0.12 ${(hue + 180) % 360})` }}
                    />
                )}
            </div>
        </div>
    )
}
