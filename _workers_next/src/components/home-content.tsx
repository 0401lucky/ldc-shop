"use client"

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { ArrowRight, Heart, Search, Sparkles, Users } from "lucide-react"
import { ProductImagePlaceholder } from "@/components/product-image-placeholder"
import { AnnouncementPopup } from "@/components/announcement-popup"
import { CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import ReactMarkdown from "react-markdown"
import { StarRatingStatic } from "@/components/star-rating-static"
import { NavigationPill } from "@/components/navigation-pill"
import { CheckInButton } from "@/components/checkin-button"
import { useI18n } from "@/lib/i18n/context"
import { INFINITE_STOCK } from "@/lib/constants"

interface Product {
    id: string
    name: string
    description: string | null
    descriptionPlain?: string | null
    price: string
    compareAtPrice?: string | null
    image: string | null
    category: string | null
    stockCount: number
    soldCount: number
    isHot?: boolean | null
    rating?: number
    reviewCount?: number
    variantCount?: number
    priceMin?: number
    priceMax?: number
}

interface HomeContentProps {
    products: Product[]
    announcement?: {
        banner: string | null
        popup: {
            title: string | null
            content: string
            signature: string
        } | null
    } | null
    visitorCount?: number
    categories?: string[]
    categoryConfig?: Array<{ name: string; icon: string | null; sortOrder: number }>
    pendingOrders?: Array<{ orderId: string; createdAt: Date; productName: string; amount: string }>
    wishlistEnabled?: boolean
    isLoggedIn?: boolean
    checkinEnabled?: boolean
    filters: { q?: string; category?: string | null; sort?: string }
    pagination: { page: number; pageSize: number; total: number }
}

export function HomeContent({
    products,
    announcement,
    visitorCount,
    categories = [],
    categoryConfig,
    pendingOrders,
    wishlistEnabled = false,
    isLoggedIn = false,
    checkinEnabled = true,
    filters,
    pagination,
}: HomeContentProps) {
    const { t } = useI18n()
    const [selectedCategory, setSelectedCategory] = useState<string | null>(filters.category || null)
    const [searchTerm, setSearchTerm] = useState(filters.q || "")
    const [sortKey, setSortKey] = useState(filters.sort || "default")
    const [page, setPage] = useState(pagination.page || 1)
    const deferredSearch = useDeferredValue(searchTerm)

    useEffect(() => {
        setPage(1)
    }, [selectedCategory, sortKey, deferredSearch])

    const filteredProducts = useMemo(() => {
        const keyword = deferredSearch.trim().toLowerCase()
        return products.filter((product) => {
            if (selectedCategory && product.category !== selectedCategory) return false
            if (!keyword) return true
            const name = (product.name || "").toLowerCase()
            const desc = (product.descriptionPlain || product.description || "").toLowerCase()
            return name.includes(keyword) || desc.includes(keyword)
        })
    }, [products, selectedCategory, deferredSearch])

    const sortedProducts = useMemo(() => {
        const list = [...filteredProducts]
        switch (sortKey) {
            case "priceAsc":
                return list.sort((a, b) => Number(a.price) - Number(b.price))
            case "priceDesc":
                return list.sort((a, b) => Number(b.price) - Number(a.price))
            case "stockDesc":
                return list.sort((a, b) => (b.stockCount || 0) - (a.stockCount || 0))
            case "soldDesc":
                return list.sort((a, b) => (b.soldCount || 0) - (a.soldCount || 0))
            case "hot":
                return list.sort((a, b) => Number(!!b.isHot) - Number(!!a.isHot))
            default:
                return list
        }
    }, [filteredProducts, sortKey])

    const totalPages = Math.max(1, Math.ceil(sortedProducts.length / pagination.pageSize))
    const currentPage = Math.min(Math.max(1, page), totalPages)
    const startIndex = (currentPage - 1) * pagination.pageSize
    const pageItems = sortedProducts.slice(startIndex, startIndex + pagination.pageSize)
    const hasMore = currentPage < totalPages
    const hasAnnouncement = Boolean(announcement?.banner)
    const hasPendingOrders = Boolean(pendingOrders && pendingOrders.length > 0)
    const sortOptions = [
        { key: "default", label: t("home.sort.default") },
        { key: "stockDesc", label: t("home.sort.stock") },
        { key: "soldDesc", label: t("home.sort.sold") },
        { key: "priceAsc", label: t("home.sort.priceAsc") },
        { key: "priceDesc", label: t("home.sort.priceDesc") },
    ] as const
    return (
        <main className="container relative overflow-hidden py-8 md:py-14">
            <AnnouncementPopup popup={announcement?.popup ?? null} />

            <div className="pointer-events-none absolute inset-0 -z-10 lucky-ambient" />

            {(hasAnnouncement || hasPendingOrders) && (
                <section className="mb-5 grid gap-3 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,0.9fr)]">
                    {hasAnnouncement && (
                        <div
                            className={cn(
                                "relative overflow-hidden rounded-[1.75rem] border border-primary/15 bg-background/72 px-5 py-4 shadow-[0_18px_45px_-34px_rgba(15,23,42,0.28)] backdrop-blur-xl",
                                !hasPendingOrders && "xl:col-span-2"
                            )}
                        >
                            <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-primary via-emerald-500/80 to-lime-400/70" />
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(34,197,94,0.12),_transparent_34%)] dark:bg-[radial-gradient(circle_at_top_right,_rgba(74,222,128,0.12),_transparent_40%)]" />
                            <div className="relative pl-2">
                                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/15 bg-primary/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                                    <Sparkles className="h-3.5 w-3.5" />
                                    <span>{t("home.announcementLabel")}</span>
                                </div>
                                <div className="prose prose-sm max-w-none text-foreground/90 dark:prose-invert [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                                    <ReactMarkdown>{announcement?.banner || ''}</ReactMarkdown>
                                </div>
                            </div>
                        </div>
                    )}

                    {hasPendingOrders && (
                        <div className="relative overflow-hidden rounded-[1.75rem] border border-yellow-500/20 bg-background/72 px-5 py-4 shadow-[0_18px_45px_-34px_rgba(15,23,42,0.28)] backdrop-blur-xl">
                            <div className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-yellow-500 to-amber-400/70" />
                            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(250,204,21,0.14),_transparent_38%)] dark:bg-[radial-gradient(circle_at_top_right,_rgba(250,204,21,0.12),_transparent_42%)]" />
                            <div className="relative pl-2">
                                <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-yellow-500/15 bg-yellow-500/8 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-yellow-700 dark:text-yellow-300">
                                    <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                                    </svg>
                                    <span>{t("home.pendingOrderLabel")}</span>
                                </div>
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                    <p className="text-sm font-medium leading-7 text-foreground/90">
                                        {pendingOrders?.length === 1
                                            ? t("home.pendingOrder.single", { orderId: pendingOrders[0].orderId })
                                            : t("home.pendingOrder.multiple", { count: pendingOrders?.length || 0 })}
                                    </p>
                                    <Link href={pendingOrders?.length === 1 ? `/order/${pendingOrders[0].orderId}` : "/orders"}>
                                        <Button size="sm" variant="outline" className="w-fit rounded-full border-yellow-500/30 hover:bg-yellow-500/10 hover:text-yellow-600 dark:hover:text-yellow-400">
                                            {pendingOrders?.length === 1 ? t("common.payNow") : t("common.viewOrders")}
                                        </Button>
                                    </Link>
                                </div>
                            </div>
                        </div>
                    )}
                </section>
            )}

            <section className="relative mb-8 overflow-hidden rounded-[2rem] border border-primary/12 bg-gradient-to-br from-card via-card/95 to-primary/8 shadow-[0_25px_80px_-40px_rgba(22,101,52,0.22)]">
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(255,255,255,0.8),_transparent_36%)] dark:bg-[radial-gradient(circle_at_top_right,_rgba(255,255,255,0.06),_transparent_36%)]" />
                <div className="absolute -right-8 -top-10 h-36 w-36 rounded-full bg-primary/10 blur-2xl" />
                <div className="absolute -bottom-12 left-1/4 h-28 w-28 rounded-full bg-lime-400/10 blur-2xl" />
                <div className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />
                <div className="relative px-6 py-5 md:px-8 md:py-6">
                    <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                        <div className="min-w-0 space-y-1.5">
                            <div className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-primary/15 bg-primary/8 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
                                <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
                                Lucky
                            </div>
                            <h1 className="bg-gradient-to-r from-foreground via-primary/80 to-emerald-600/70 dark:via-primary/90 dark:to-lime-300/70 bg-clip-text text-lg font-semibold tracking-tight text-transparent sm:text-xl">
                                {t("home.title")}
                            </h1>
                            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                                {t("home.subtitle")}
                            </p>
                        </div>
                        <div className="flex w-full flex-col items-stretch gap-2 md:w-auto md:flex-row md:items-center md:justify-end md:gap-3">
                            {isLoggedIn && (
                                <CheckInButton
                                    enabled={checkinEnabled}
                                    showCheckedInLabel
                                    className="flex w-full md:w-auto"
                                />
                            )}
                            <div className="flex flex-wrap items-center gap-2 md:gap-3">
                                {typeof visitorCount === "number" && (
                                    <div className="inline-flex items-center gap-2 rounded-full border border-border/40 bg-background/60 px-3.5 py-2 text-sm backdrop-blur-sm">
                                        <Users className="h-3.5 w-3.5 text-primary" />
                                        <span className="font-semibold tabular-nums text-foreground">{visitorCount}</span>
                                        <span className="text-xs text-muted-foreground">{t("home.metrics.visitors")}</span>
                                    </div>
                                )}
                                {wishlistEnabled && (
                                    <Link href="/wishlist" className="inline-flex">
                                        <Button variant="outline" className="h-10 rounded-2xl border-border/50 bg-background/70 px-4 shadow-none">
                                            <Heart className="mr-2 h-4 w-4" />
                                            {t("wishlist.title")}
                                        </Button>
                                    </Link>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section className="mb-10 space-y-4">
                <div className="flex flex-col gap-4 rounded-[1.8rem] border border-primary/10 bg-card/75 p-4 shadow-[0_20px_50px_-36px_rgba(22,101,52,0.18)] backdrop-blur-md">
                    <div className="grid gap-4 xl:grid-cols-[minmax(0,17rem)_minmax(0,1fr)_auto] xl:items-center">
                        <div className="relative w-full">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                            <Input
                                placeholder={t("common.searchPlaceholder")}
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="h-11 rounded-2xl border-border/50 bg-background/90 pl-10 shadow-none"
                            />
                        </div>

                        <div className="w-full overflow-x-auto no-scrollbar pb-2 xl:pb-0">
                            <NavigationPill
                                items={[
                                    { key: "", label: t("common.all") },
                                    ...categories.map((cat) => {
                                        const categoryIcon = categoryConfig?.find((c) => c.name === cat)?.icon
                                        return {
                                            key: cat,
                                            label: categoryIcon ? `${categoryIcon} ${cat}` : cat,
                                        }
                                    }),
                                ]}
                                selectedKey={selectedCategory || ""}
                                onSelect={(key) => setSelectedCategory(key || null)}
                            />
                        </div>

                        <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pb-2 xl:pb-0">
                            {sortOptions.map((opt) => (
                                <Button
                                    key={opt.key}
                                    type="button"
                                    variant={sortKey === opt.key ? "secondary" : "ghost"}
                                    size="sm"
                                    className={cn(
                                        "h-10 rounded-2xl px-4 whitespace-nowrap text-xs",
                                        sortKey === opt.key
                                            ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground"
                                    )}
                                    onClick={() => setSortKey(opt.key)}
                                >
                                    {opt.label}
                                </Button>
                            ))}
                        </div>
                    </div>
                </div>
            </section>

            <section>
                <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                    <div>
                        <h2 className="text-lg font-medium tracking-tight text-foreground/90 md:text-xl">
                            {t("home.catalogTitle")}
                        </h2>
                    </div>
                    <Badge variant="secondary" className="w-fit rounded-full border border-border/50 bg-background/80 px-4 py-2">
                        {t("home.resultsCount", { count: sortedProducts.length })}
                    </Badge>
                </div>

                {sortedProducts.length === 0 ? (
                    <div className="relative overflow-hidden rounded-[2rem] border border-dashed border-border/50 bg-muted/25 px-6 py-20 text-center">
                        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(34,197,94,0.1),_transparent_60%)] dark:bg-[radial-gradient(circle_at_center,_rgba(74,222,128,0.1),_transparent_65%)]" />
                        <div className="relative mb-4 inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/8 text-primary shadow-sm ring-1 ring-primary/10">
                            <svg className="h-8 w-8 opacity-70" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                <ellipse cx="12" cy="6.5" rx="3.2" ry="4" />
                                <ellipse cx="17.5" cy="12" rx="4" ry="3.2" />
                                <ellipse cx="12" cy="17.5" rx="3.2" ry="4" />
                                <ellipse cx="6.5" cy="12" rx="4" ry="3.2" />
                                <circle cx="12" cy="12" r="1.6" fill="currentColor" opacity="0.45" />
                            </svg>
                        </div>
                        <p className="relative font-medium text-muted-foreground">{t("home.noProducts")}</p>
                        <p className="relative mt-2 text-sm text-muted-foreground/70">{t("home.checkBackLater")}</p>
                        {selectedCategory && (
                            <Button variant="link" className="relative mt-4" onClick={() => setSelectedCategory(null)}>
                                {t("common.all")}
                            </Button>
                        )}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                        {pageItems.map((product, index) => (
                            <Link
                                key={product.id}
                                href={`/buy/${product.id}`}
                                prefetch={false}
                                aria-label={t("common.viewDetails")}
                                className={cn(
                                    "group tech-card relative flex h-full flex-col overflow-hidden rounded-[1.8rem] border border-primary/10 bg-card/90 shadow-[0_20px_50px_-38px_rgba(22,101,52,0.2)] transition-all duration-300 animate-in fade-in slide-in-from-bottom-2 motion-reduce:animate-none cursor-pointer",
                                    product.stockCount <= 0 && "opacity-90"
                                )}
                                style={{ animationDelay: `${index * 60}ms` }}
                            >
                                <div className="absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
                                <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(34,197,94,0.1),_transparent_32%)] opacity-80 dark:bg-[radial-gradient(circle_at_top_right,_rgba(74,222,128,0.12),_transparent_36%)]" />

                                <div className="relative m-4 aspect-[4/3] overflow-hidden rounded-[1.45rem] bg-card/50">
                                    {product.image ? (
                                        <Image
                                            src={product.image}
                                            alt={product.name}
                                            fill
                                            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                                            priority={index < 2}
                                            className="object-contain p-2 md:p-3 transition-transform duration-700 ease-out group-hover:scale-[1.04]"
                                        />
                                    ) : (
                                        <div className="flex h-full items-center justify-center p-2 md:p-3 transition-transform duration-700 ease-out group-hover:scale-[1.04]">
                                            <ProductImagePlaceholder productId={product.id} productName={product.name} size="sm" fill />
                                        </div>
                                    )}
                                    <div className="absolute left-3 right-3 top-3 flex items-start justify-between gap-2">
                                        {product.category && product.category !== "general" ? (
                                            <Badge className="h-7 rounded-full border border-border/40 bg-background/86 px-3 text-[10px] font-medium capitalize text-foreground shadow-sm">
                                                {product.category}
                                            </Badge>
                                        ) : (
                                            <span />
                                        )}
                                        <Badge
                                            className={cn(
                                                "h-7 rounded-full border px-3 text-[10px] font-medium shadow-sm",
                                                product.stockCount > 0
                                                    ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                                    : "border-rose-500/20 bg-rose-500/10 text-rose-700 dark:text-rose-300"
                                            )}
                                        >
                                            {product.stockCount > 0 ? t("common.inStock") : t("common.outOfStock")}
                                        </Badge>
                                    </div>
                                    {product.isHot && (
                                        <Badge className="absolute bottom-3 left-3 h-7 rounded-full border-0 bg-orange-500 px-3 text-[10px] font-semibold text-white shadow-lg shadow-orange-500/20">
                                            🔥 {t("buy.hot")}
                                        </Badge>
                                    )}
                                </div>

                                <CardContent className="relative z-20 flex flex-1 flex-col px-5 pb-5 pt-1">
                                    <div className="mb-3 flex items-start justify-between gap-3">
                                        <div className="space-y-2">
                                            <h3
                                                className="line-clamp-1 text-lg font-semibold tracking-tight text-foreground transition-colors duration-300 group-hover:text-primary"
                                                title={product.name}
                                            >
                                                {product.name}
                                            </h3>
                                            {product.reviewCount !== undefined && product.reviewCount > 0 && (
                                                <div className="flex items-center gap-2">
                                                    <StarRatingStatic rating={Math.round(product.rating || 0)} size="xs" />
                                                    <span className="text-[11px] font-medium text-muted-foreground">
                                                        {product.reviewCount}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="mb-5 line-clamp-3 min-h-[3.9rem] text-sm leading-6 text-muted-foreground/90">
                                        {product.descriptionPlain || product.description || t("buy.noDescription")}
                                    </div>

                                    <div className="mt-auto rounded-[1.3rem] border border-border/30 bg-muted/30 px-4 py-3">
                                        <div className="flex flex-wrap items-center gap-2">
                                            {product.variantCount != null && product.variantCount > 1 && (
                                                <Badge variant="secondary" className="rounded-full text-[10px] font-medium">
                                                    {t("home.variantCount", { count: product.variantCount })}
                                                </Badge>
                                            )}
                                        </div>
                                        <div className="flex items-end justify-between gap-4">
                                            <div className="min-w-0">
                                                <div className="flex flex-wrap items-baseline gap-2">
                                                    {product.variantCount != null && product.variantCount > 1 && product.priceMin != null && product.priceMax != null ? (
                                                        <>
                                                            <span className="whitespace-nowrap text-2xl font-semibold tracking-tight text-primary tabular-nums">
                                                                {product.priceMin} - {product.priceMax}
                                                            </span>
                                                            <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                                                                {t("common.credits")}
                                                            </span>
                                                        </>
                                                    ) : product.variantCount != null && product.variantCount > 1 && product.priceMin != null ? (
                                                        <>
                                                            <span className="whitespace-nowrap text-2xl font-semibold tracking-tight text-primary tabular-nums">
                                                                {t("home.priceFrom", { price: product.priceMin })}
                                                            </span>
                                                            <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                                                                {t("common.credits")}
                                                            </span>
                                                        </>
                                                    ) : (
                                                        <>
                                                            <span className="whitespace-nowrap text-2xl font-semibold tracking-tight text-primary tabular-nums">
                                                                {Number(product.price)}
                                                            </span>
                                                            <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                                                                {t("common.credits")}
                                                            </span>
                                                            {product.compareAtPrice && Number(product.compareAtPrice) > Number(product.price) && (
                                                                <>
                                                                    <span className="text-sm tabular-nums text-muted-foreground/50 line-through">
                                                                        {Number(product.compareAtPrice)}
                                                                    </span>
                                                                    <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-semibold text-red-600 dark:bg-red-500/15 dark:text-red-400">
                                                                        -{Math.round((1 - Number(product.price) / Number(product.compareAtPrice)) * 100)}%
                                                                    </span>
                                                                </>
                                                            )}
                                                        </>
                                                    )}
                                                </div>
                                                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                                                    <span>{t("common.stock")}: {product.stockCount >= INFINITE_STOCK ? "∞" : product.stockCount}</span>
                                                    <span>{t("common.sold")}: {product.soldCount}</span>
                                                </div>
                                            </div>

                                            <div className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/8 text-primary/80 transition-all duration-300 group-hover:border-primary/35 group-hover:bg-primary group-hover:text-primary-foreground group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:shadow-md group-hover:shadow-primary/20">
                                                <ArrowRight className="h-4.5 w-4.5" />
                                            </div>
                                        </div>
                                    </div>
                                </CardContent>
                            </Link>
                        ))}
                    </div>
                )}
            </section>

            {sortedProducts.length > 0 && (
                <nav className="mt-10 flex flex-wrap items-center justify-center gap-3 sm:justify-between">
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <span className="font-medium">
                            {t("search.page", { page: currentPage, totalPages })}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-9 rounded-xl px-3"
                            onClick={() => setPage((p) => Math.max(1, p - 1))}
                            disabled={currentPage <= 1}
                        >
                            {t("search.prev")}
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-9 rounded-xl px-3"
                            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                            disabled={!hasMore}
                        >
                            {t("search.next")}
                        </Button>
                        {hasMore && (
                            <Button variant="secondary" size="sm" className="h-9 rounded-xl px-4" onClick={() => setPage(currentPage + 1)}>
                                {t("common.loadMore")}
                            </Button>
                        )}
                    </div>
                </nav>
            )}
        </main>
    )
}
