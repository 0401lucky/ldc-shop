function hashString(input: string): number {
    let hash = 2166136261
    for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i)
        hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
}

function createRandom(seed: number) {
    let state = seed >>> 0
    return () => {
        state += 0x6D2B79F5
        let t = state
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function hsl(h: number, s: number, l: number) {
    return `hsl(${h} ${s}% ${l}%)`
}

function formatNumber(value: number): string {
    return Number(value.toFixed(1)).toString()
}

type LogoPalette = {
    bgStart: string
    bgEnd: string
    glow: string
    shell: string
    shellSoft: string
    accent: string
    accentSoft: string
    border: string
}

function buildSignature(random: () => number, palette: LogoPalette): string {
    const bars = Array.from({ length: 4 }, (_, index) => {
        const x = 16 + index * 4.5
        const height = 4 + Math.floor(random() * 8)
        const y = 54 - height
        const fill = index % 2 === 0 ? palette.shellSoft : palette.accent
        return `<rect x="${formatNumber(x)}" y="${formatNumber(y)}" width="2.5" height="${height}" rx="1.25" fill="${fill}" opacity="${formatNumber(0.72 + index * 0.06)}" />`
    })
    return `<g opacity="0.92">${bars.join("")}</g>`
}

function buildMarkVariant(variant: number, random: () => number, palette: LogoPalette): string {
    const rotation = [-16, -10, -6, 0, 6, 10, 16][Math.floor(random() * 7)]
    const accentDotX = formatNumber(42 + (random() > 0.5 ? 3 : -3))
    const accentDotY = formatNumber(22 + Math.floor(random() * 18))
    const dashA = formatNumber(46 + random() * 10)
    const dashB = formatNumber(26 + random() * 8)

    switch (variant) {
        case 0:
            return `
  <g transform="rotate(${rotation} 32 32)">
    <circle cx="32" cy="32" r="14" fill="none" stroke="${palette.shellSoft}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${dashA} ${dashB}" />
    <rect x="28" y="18" width="8" height="28" rx="4" fill="${palette.shell}" />
    <circle cx="${accentDotX}" cy="${accentDotY}" r="4.5" fill="${palette.accent}" />
  </g>`.trim()
        case 1:
            return `
  <g transform="rotate(${rotation} 32 32)">
    <rect x="18" y="18" width="12" height="28" rx="6" fill="${palette.shell}" />
    <rect x="34" y="18" width="12" height="12" rx="6" fill="${palette.shellSoft}" />
    <rect x="34" y="34" width="12" height="12" rx="6" fill="${palette.accent}" />
    <path d="M23 32H41" stroke="${palette.border}" stroke-width="2.5" stroke-linecap="round" opacity="0.6" />
  </g>`.trim()
        case 2:
            return `
  <g transform="rotate(${rotation} 32 32)">
    <rect x="18" y="18" width="28" height="28" rx="10" fill="${palette.shellSoft}" transform="rotate(45 32 32)" />
    <path d="M24 40L40 24" stroke="${palette.shell}" stroke-width="5" stroke-linecap="round" />
    <circle cx="41.5" cy="41.5" r="4" fill="${palette.accent}" />
  </g>`.trim()
        case 3:
            return `
  <g transform="rotate(${rotation} 32 32)">
    <path d="M18 42C18 27 27 18 42 18V26C31 26 26 31 26 42Z" fill="${palette.shell}" />
    <path d="M46 22C46 37 37 46 22 46V38C33 38 38 33 38 22Z" fill="${palette.shellSoft}" />
    <circle cx="40" cy="24" r="4.5" fill="${palette.accent}" />
  </g>`.trim()
        case 4:
            return `
  <g transform="rotate(${rotation} 32 32)">
    <rect x="18" y="20" width="8" height="24" rx="4" fill="${palette.shell}" />
    <rect x="29" y="16" width="8" height="32" rx="4" fill="${palette.shellSoft}" />
    <rect x="40" y="24" width="8" height="20" rx="4" fill="${palette.accent}" />
    <rect x="18" y="49" width="30" height="4" rx="2" fill="${palette.border}" opacity="0.55" />
  </g>`.trim()
        case 5:
            return `
  <g transform="rotate(${rotation} 32 32)">
    <rect x="18" y="18" width="28" height="28" rx="11" fill="${palette.shell}" />
    <path d="M22 38H42" stroke="${palette.shellSoft}" stroke-width="6" stroke-linecap="round" />
    <path d="M32 22V42" stroke="${palette.accent}" stroke-width="6" stroke-linecap="round" />
  </g>`.trim()
        default:
            return `
  <g transform="rotate(${rotation} 32 32)">
    <path d="M18 44L30 18H38L46 44H39L37 38H27L24.5 44Z" fill="${palette.shell}" />
    <path d="M29 32H36" stroke="${palette.accentSoft}" stroke-width="4" stroke-linecap="round" />
    <circle cx="42" cy="24" r="4" fill="${palette.accent}" />
  </g>`.trim()
    }
}

export function buildDefaultLogoSvg(seed: string): string {
    const normalizedSeed = seed.trim() || "ldc-shop"
    const random = createRandom(hashString(normalizedSeed))

    // Lucky clover green family (fresh mint → deep forest)
    const hue = 128 + Math.floor(random() * 32) // ~128-160
    const accentHue = (hue + 18 + Math.floor(random() * 24)) % 360
    const bgStart = hsl(hue, 58, 46)
    const bgEnd = hsl((hue + 12 + Math.floor(random() * 18)) % 360, 62, 28)
    const glow = hsl((accentHue + 8) % 360, 72, 72)
    const shell = hsl(hue, 42, 92)
    const shellSoft = hsl(accentHue, 48, 78)
    const accent = hsl((accentHue + 8) % 360, 70, 62)
    const accentSoft = hsl((accentHue + 12) % 360, 78, 82)
    const border = hsl(hue, 30, 90)
    const palette: LogoPalette = {
        bgStart,
        bgEnd,
        glow,
        shell,
        shellSoft,
        accent,
        accentSoft,
        border,
    }

    // Prefer clover mark; occasionally other organic variants
    const variant = random() > 0.35 ? 6 : Math.floor(random() * 6)
    const mark = variant === 6
        ? `
  <g transform="translate(32 30)">
    <ellipse cx="0" cy="-9" rx="6.2" ry="8" fill="${palette.shell}" />
    <ellipse cx="9" cy="0" rx="8" ry="6.2" fill="${palette.shellSoft}" />
    <ellipse cx="0" cy="9" rx="6.2" ry="8" fill="${palette.shell}" />
    <ellipse cx="-9" cy="0" rx="8" ry="6.2" fill="${palette.shellSoft}" />
    <circle cx="0" cy="0" r="3.2" fill="${palette.accent}" />
  </g>
  <path d="M32 38c0 4 1 7.5 3 10.5" stroke="${palette.accentSoft}" stroke-width="2.4" stroke-linecap="round" />`.trim()
        : buildMarkVariant(variant, random, palette)
    const signature = buildSignature(random, palette)

    return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <defs>
    <linearGradient id="bg" x1="10" y1="6" x2="56" y2="58" gradientUnits="userSpaceOnUse">
      <stop stop-color="${palette.bgStart}" />
      <stop offset="1" stop-color="${palette.bgEnd}" />
    </linearGradient>
    <linearGradient id="glass" x1="18" y1="16" x2="46" y2="48" gradientUnits="userSpaceOnUse">
      <stop stop-color="white" stop-opacity="0.22" />
      <stop offset="1" stop-color="white" stop-opacity="0.04" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="18" fill="url(#bg)" />
  <circle cx="14" cy="12" r="18" fill="${palette.glow}" opacity="0.18" />
  <circle cx="53" cy="50" r="15" fill="${palette.accentSoft}" opacity="0.14" />
  <rect x="10" y="10" width="44" height="44" rx="16" fill="url(#glass)" />
  ${mark}
  ${signature}
  <rect x="1" y="1" width="62" height="62" rx="17" stroke="${palette.border}" opacity="0.32" />
</svg>`.trim()
}

export function buildDefaultLogoDataUrl(seed: string): string {
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(buildDefaultLogoSvg(seed))}`
}
