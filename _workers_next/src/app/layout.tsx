import type { Metadata } from "next";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { MobileNavWrapper } from "@/components/mobile-nav-wrapper";
import { Providers } from "@/components/providers";
import { cn } from "@/lib/utils";
import { getSetting } from "@/lib/db/queries";
import { Suspense } from "react";
import { detectServerLocale } from "@/lib/i18n/server";
import type { Locale } from "@/lib/i18n/shared";
import { DEFAULT_MONO_FONT_STACK, getThemeFontStack, getThemeFontStylesheetHref } from "@/lib/theme-fonts";

const DEFAULT_TITLE = "LDC Virtual Goods Shop";
const DEFAULT_DESCRIPTION = "High-quality virtual goods, instant delivery";
const THEME_HUES: Record<string, number> = {
  purple: 270,
  indigo: 255,
  blue: 240,
  cyan: 200,
  teal: 170,
  green: 145, // lucky clover default
  lime: 120,
  amber: 85,
  orange: 45,
  red: 25,
  rose: 345,
  pink: 330,
  black: 0,
};
const THEME_CHROMA: Record<string, number> = {
  black: 0,
};
const THEME_PRIMARY_L: Record<string, number> = {
  black: 0.2,
  green: 0.48,
};
const THEME_PRIMARY_DARK_L: Record<string, number> = {
  black: 0.8,
  green: 0.72,
};

export async function generateMetadata(): Promise<Metadata> {
  let shopName: string | null = null;
  let shopDescription: string | null = null;
  let noIndex = false;
  let logoUpdatedAt: string | null = null;
  try {
    const [name, desc, noIndexSetting, logoUpdatedAtSetting] = await Promise.all([
      getSetting("shop_name"),
      getSetting("shop_description"),
      getSetting("noindex_enabled"),
      getSetting("shop_logo_updated_at"),
    ]);
    shopName = name;
    shopDescription = desc;
    noIndex = noIndexSetting === 'true';
    logoUpdatedAt = logoUpdatedAtSetting;
  } catch {
    shopName = null;
    shopDescription = null;
  }

  const metadata: Metadata = {
    title: shopName?.trim() || DEFAULT_TITLE,
    description: shopDescription?.trim() || DEFAULT_DESCRIPTION,
    robots: noIndex ? { index: false, follow: false } : undefined,
    manifest: "/manifest.json",
    appleWebApp: {
      capable: true,
      statusBarStyle: "black-translucent",
      title: shopName?.trim() || DEFAULT_TITLE,
    },
    formatDetection: {
      telephone: false,
    },
    other: {
      "mobile-web-app-capable": "yes",
    },
    icons: {
      icon: logoUpdatedAt ? `/favicon?v=${logoUpdatedAt}` : "/favicon",
      shortcut: logoUpdatedAt ? `/favicon?v=${logoUpdatedAt}` : "/favicon",
      apple: logoUpdatedAt ? `/favicon?v=${logoUpdatedAt}` : "/favicon",
    },
  };

  return metadata;
}

async function RootLayoutContent({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let themeColor: string | null = null;
  let themeFont: string | null = null;
  let currencyUnit: string | null = null;
  let initialLocale: Locale = "en";
  try {
    const [resolvedThemeColor, resolvedThemeFont, resolvedCurrencyUnit, resolvedLocale] = await Promise.all([
      getSetting("theme_color"),
      getSetting("theme_font"),
      getSetting("currency_unit"),
      detectServerLocale(),
    ]);
    themeColor = resolvedThemeColor;
    themeFont = resolvedThemeFont;
    currencyUnit = resolvedCurrencyUnit;
    initialLocale = resolvedLocale;
  } catch {
    themeColor = null;
    themeFont = null;
    currencyUnit = null;
    initialLocale = "en";
  }
  const themeHue = THEME_HUES[themeColor || "green"] || 150;
  const themeChroma = THEME_CHROMA[themeColor || "green"] ?? 1;
  const themePrimaryL = THEME_PRIMARY_L[themeColor || "green"] ?? 0.48;
  const themePrimaryDarkL = THEME_PRIMARY_DARK_L[themeColor || "green"] ?? 0.72;
  const themeFontStack = getThemeFontStack(themeFont);
  const themeFontStylesheetHref = getThemeFontStylesheetHref(themeFont);

  return (
    <html
      lang={initialLocale === "zh" ? "zh-CN" : "en"}
      suppressHydrationWarning
      style={{
        ["--theme-hue" as any]: themeHue,
        ["--theme-chroma" as any]: themeChroma,
        ["--theme-primary-l" as any]: themePrimaryL,
        ["--theme-primary-dark-l" as any]: themePrimaryDarkL,
        ["--app-font-sans" as any]: themeFontStack,
        ["--app-font-mono" as any]: DEFAULT_MONO_FONT_STACK,
      }}
    >
      <head>
        {themeFontStylesheetHref && (
          <>
            <link rel="preconnect" href="https://fonts.googleapis.com" />
            <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
            <link rel="stylesheet" href={themeFontStylesheetHref} />
          </>
        )}
        {/* Polyfill for esbuild's __name helper - fixes "__name is not defined" error on Cloudflare Workers */}
        <script
          dangerouslySetInnerHTML={{
            __html: `var __name = function(fn, name) { return Object.defineProperty(fn, "name", { value: name, configurable: true }); };`,
          }}
        />
      </head>
      <body className={cn("min-h-screen bg-background font-sans antialiased")}>
        <Providers themeColor={themeColor} initialLocale={initialLocale} currencyUnit={currencyUnit}>
          <div className="relative flex min-h-screen flex-col">
            <SiteHeader />
            <div className="flex-1 pb-16 md:pb-0">{children}</div>
            <SiteFooter />
            <MobileNavWrapper />
          </div>
        </Providers>
      </body>
    </html>
  );
}

function RootLayoutFallback() {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background font-sans antialiased")}>
        <div className="relative flex min-h-screen flex-col">
          <div className="h-16 border-b border-border/40 bg-background/70" />
          <div className="flex-1" />
          <div className="h-16 border-t border-border/40 bg-background/70" />
        </div>
      </body>
    </html>
  )
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <Suspense fallback={<RootLayoutFallback />}>
      <RootLayoutContent>{children}</RootLayoutContent>
    </Suspense>
  )
}
