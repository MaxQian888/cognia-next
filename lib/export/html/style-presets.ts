// Style presets layer decorative "chrome" (fonts, banners, backgrounds,
// corner marks) on top of the flat color tokens in `syntax-themes.ts`.
// A preset is keyed by ThemeId: themes without an entry keep the classic
// export layout untouched. `beautiful-html.ts` (and therefore the animated
// export and share links) consumes these, and the usage share card reuses
// the same chrome so every "Arknights style" surface looks identical.

import type { ThemeId, ThemeTokens } from "./syntax-themes"

export interface StylePreset {
  /** Extra CSS appended after the base stylesheet. */
  css: (t: ThemeTokens) => string
  /** Uppercase tag rendered in a banner strip above the title. */
  bannerText?: string
  /** Footer tagline appended to the export footer. */
  footerText?: string
}

const MONO_STACK = `"JetBrains Mono", "Cascadia Code", "SFMono-Regular", Consolas, "Noto Sans Mono", monospace`

export const STYLE_PRESETS: Partial<Record<ThemeId, StylePreset>> = {
  arknights: {
    bannerText: "TACTICAL COMMUNICATION LOG",
    footerText: "PRTS // RECORD SEALED",
    css: (t) => `
body { font-family: ${MONO_STACK}; background-image: linear-gradient(${hairline(t.accent)} 1px, transparent 1px), linear-gradient(90deg, ${hairline(t.accent)} 1px, transparent 1px); background-size: 28px 28px; }
.preset-banner { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; padding: 8px 12px; border: 1px solid ${t.border}; border-left: 3px solid ${t.accent}; background: ${t.surface}; color: ${t.accent}; font-size: 12px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; }
.preset-banner::after { content: ""; flex: 1; height: 1px; background: repeating-linear-gradient(90deg, ${t.accent} 0 6px, transparent 6px 12px); opacity: 0.5; }
header h1 { text-transform: uppercase; letter-spacing: 0.08em; }
.message { border-radius: 2px; border-left: 3px solid ${t.border}; }
.message-user { border-left-color: ${t.accent}; }
.message .role { text-transform: uppercase; letter-spacing: 0.18em; font-size: 11px; }
pre, details.tool, details.reasoning { border-radius: 2px; }
.exported { text-transform: uppercase; letter-spacing: 0.2em; font-size: 10px; }
`,
  },
  cyberpunk: {
    bannerText: "NIGHT CITY UPLINK",
    footerText: "TRANSMISSION ENDS",
    css: (t) => `
body { font-family: ${MONO_STACK}; }
.preset-banner { margin: 0 0 14px; padding: 8px 12px; border: 1px solid ${t.accent}; color: ${t.accent}; font-size: 12px; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; text-shadow: 0 0 8px ${t.accent}; box-shadow: 0 0 12px ${hairline(t.accent)} inset; }
header h1 { text-shadow: 0 0 10px ${t.accent}; text-transform: uppercase; letter-spacing: 0.06em; }
.message { border-radius: 0; }
.message .role { text-transform: uppercase; letter-spacing: 0.16em; }
.exported { letter-spacing: 0.2em; text-transform: uppercase; }
`,
  },
  terminal: {
    bannerText: "SESSION TRANSCRIPT",
    footerText: "EOF",
    css: (t) => `
body { font-family: ${MONO_STACK}; }
.preset-banner { margin: 0 0 14px; color: ${t.accent}; font-size: 12px; letter-spacing: 0.18em; }
.preset-banner::before { content: "$ "; }
header h1 { font-size: 20px; }
.message { border-radius: 0; border-style: dashed; }
.message .role::before { content: "> "; }
`,
  },
  sakura: {
    bannerText: "花見録 · HANAMI LOG",
    css: (t) => `
.preset-banner { margin: 0 0 14px; padding: 6px 12px; border-radius: 999px; display: inline-block; background: ${t.surface}; border: 1px solid ${t.border}; color: ${t.accent}; font-size: 12px; letter-spacing: 0.14em; }
.message { border-radius: 18px; }
header h1::after { content: " ✿"; color: ${t.accent}; }
`,
  },
}

/** Preset for a theme id, or undefined for classic themes. */
export function getStylePreset(theme: ThemeId | undefined): StylePreset | undefined {
  return theme ? STYLE_PRESETS[theme] : undefined
}

/** 20%-alpha hairline of a hex accent color for grids/glows. */
function hairline(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "rgba(128,128,128,0.2)"
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},0.12)`
}
