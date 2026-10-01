import { sanitizeActivityLabel } from "@/lib/execution/run-activity"

/** Shared by the settings form, native presenter, and queued card builders. */
export const LARK_CARD_THEMES = [
  "status",
  "blue",
  "wathet",
  "turquoise",
  "green",
  "yellow",
  "orange",
  "red",
  "carmine",
  "violet",
  "purple",
  "indigo",
  "grey",
] as const

export const LARK_CARD_TEXT_SIZES = [
  "normal",
  "notation",
  "heading-4",
  "heading-3",
  "heading-2",
] as const

export interface LarkCardPresentation {
  theme: (typeof LARK_CARD_THEMES)[number]
  density: "comfortable" | "compact"
  width: "default" | "compact" | "fill"
  processMode: "auto" | "card"
  history: "auto" | "expanded" | "collapsed"
  showElapsed: boolean
  showProgress: boolean
  showArtifacts: boolean
  showQuote: boolean
  showFooter: boolean
  title: string
  subtitle: string
  headerIconKey: string
  headerTags: string
  desktopTextSize: (typeof LARK_CARD_TEXT_SIZES)[number]
  mobileTextSize: (typeof LARK_CARD_TEXT_SIZES)[number]
  panelColorLight: string
  panelColorDark: string
  resultTemplateEnabled: boolean
  resultTemplateId: string
  resultTemplateVersion: string
}

export const DEFAULT_LARK_CARD_PRESENTATION: Readonly<LarkCardPresentation> = {
  theme: "status",
  density: "comfortable",
  width: "default",
  processMode: "auto",
  history: "auto",
  showElapsed: true,
  showProgress: true,
  showArtifacts: true,
  showQuote: true,
  showFooter: true,
  title: "",
  subtitle: "",
  headerIconKey: "",
  headerTags: "",
  desktopTextSize: "normal",
  mobileTextSize: "normal",
  panelColorLight: "",
  panelColorDark: "",
  resultTemplateEnabled: false,
  resultTemplateId: "",
  resultTemplateVersion: "",
}

/** Persisted settings are untrusted and may come from an older client. */
export function normalizeLarkCardPresentation(value: unknown): LarkCardPresentation {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {}
  const result = { ...DEFAULT_LARK_CARD_PRESENTATION }
  const select = <T extends string>(key: string, values: readonly T[], fallback: T): T =>
    values.includes(raw[key] as T) ? (raw[key] as T) : fallback
  result.theme = select("theme", LARK_CARD_THEMES, result.theme)
  result.density = select("density", ["comfortable", "compact"], result.density)
  result.width = select("width", ["default", "compact", "fill"], result.width)
  result.processMode = select("processMode", ["auto", "card"], result.processMode)
  result.history = select("history", ["auto", "expanded", "collapsed"], result.history)
  result.desktopTextSize = select("desktopTextSize", LARK_CARD_TEXT_SIZES, result.desktopTextSize)
  result.mobileTextSize = select("mobileTextSize", LARK_CARD_TEXT_SIZES, result.mobileTextSize)
  for (const key of [
    "showElapsed",
    "showProgress",
    "showArtifacts",
    "showQuote",
    "showFooter",
    "resultTemplateEnabled",
  ] as const) {
    if (typeof raw[key] === "boolean") result[key] = raw[key]
  }
  if (typeof raw.title === "string" && raw.title.trim()) {
    result.title = sanitizeActivityLabel(raw.title, "").slice(0, 60)
  }
  if (typeof raw.subtitle === "string")
    result.subtitle = sanitizeActivityLabel(raw.subtitle, "").slice(0, 120)
  if (typeof raw.headerTags === "string")
    result.headerTags = raw.headerTags
      .split(",")
      .map((tag) => sanitizeActivityLabel(tag.trim(), "").slice(0, 20))
      .filter(Boolean)
      .slice(0, 3)
      .join(", ")
  if (
    typeof raw.headerIconKey === "string" &&
    /^img_[A-Za-z0-9_-]{1,250}$/.test(raw.headerIconKey.trim())
  )
    result.headerIconKey = raw.headerIconKey.trim()
  for (const key of ["panelColorLight", "panelColorDark"] as const) {
    if (typeof raw[key] === "string" && /^#[a-fA-F0-9]{6}$/.test(raw[key].trim()))
      result[key] = raw[key].trim()
  }
  for (const key of ["resultTemplateId", "resultTemplateVersion"] as const) {
    if (typeof raw[key] === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(raw[key].trim()))
      result[key] = raw[key].trim()
  }
  if (!result.resultTemplateId || !result.resultTemplateVersion)
    result.resultTemplateEnabled = false
  return result
}

/** Validate the editable draft before normalization; never silently discard user input on save. */
export function validateLarkCardPresentation(
  value: LarkCardPresentation
): "invalidIcon" | "invalidColor" | "invalidTemplate" | "invalidTags" | null {
  if (value.headerIconKey.trim() && !/^img_[A-Za-z0-9_-]{1,250}$/.test(value.headerIconKey.trim()))
    return "invalidIcon"
  if (
    [value.panelColorLight, value.panelColorDark].some(
      (color) => color.trim() && !/^#[a-fA-F0-9]{6}$/.test(color.trim())
    ) ||
    Boolean(value.panelColorLight.trim()) !== Boolean(value.panelColorDark.trim())
  )
    return "invalidColor"
  if (
    value.headerTags.split(",").filter((tag) => tag.trim()).length > 3 ||
    value.headerTags.split(",").some((tag) => tag.trim().length > 20)
  )
    return "invalidTags"
  if (
    value.resultTemplateEnabled &&
    [value.resultTemplateId, value.resultTemplateVersion].some(
      (field) => !/^[A-Za-z0-9_.-]{1,100}$/.test(field.trim())
    )
  )
    return "invalidTemplate"
  return null
}

export function larkCardConfigStyle(presentation: LarkCardPresentation): Record<string, unknown> {
  const style: Record<string, unknown> = {}
  if (presentation.desktopTextSize !== "normal" || presentation.mobileTextSize !== "normal") {
    style.text_size = {
      "cognia-body": {
        default: "normal",
        pc: presentation.desktopTextSize,
        mobile: presentation.mobileTextSize,
      },
    }
  }
  if (presentation.panelColorLight && presentation.panelColorDark) {
    const rgba = (hex: string) =>
      `rgba(${[1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16)).join(",")},1)`
    style.color = {
      "cognia-panel": {
        light_mode: rgba(presentation.panelColorLight),
        dark_mode: rgba(presentation.panelColorDark),
      },
    }
  }
  return Object.keys(style).length ? { style } : {}
}

export function larkCardMarkdownStyle(presentation: LarkCardPresentation): Record<string, string> {
  return presentation.desktopTextSize !== "normal" || presentation.mobileTextSize !== "normal"
    ? { text_size: "cognia-body" }
    : {}
}

export function larkCardPanelStyle(presentation: LarkCardPresentation): Record<string, string> {
  return presentation.panelColorLight && presentation.panelColorDark
    ? { background_color: "cognia-panel" }
    : {}
}

export function larkCardHeaderExtras(presentation: LarkCardPresentation): Record<string, unknown> {
  return {
    ...(presentation.subtitle
      ? { subtitle: { tag: "plain_text", content: presentation.subtitle } }
      : {}),
    ...(presentation.headerIconKey
      ? { icon: { tag: "custom_icon", img_key: presentation.headerIconKey } }
      : {}),
    ...(presentation.headerTags
      ? {
          text_tag_list: presentation.headerTags.split(",").map((tag) => ({
            tag: "text_tag",
            text: { tag: "plain_text", content: tag.trim() },
            color: "neutral",
          })),
        }
      : {}),
  }
}

/** Error and waiting colors remain semantic even with a custom theme. */
export function larkCardHeaderTheme(presentation: LarkCardPresentation, semantic: string): string {
  return semantic === "red" || semantic === "orange" || presentation.theme === "status"
    ? semantic
    : presentation.theme
}

export function larkCardBodyStyle(presentation: LarkCardPresentation): Record<string, string> {
  return presentation.density === "compact"
    ? { padding: "8px", vertical_spacing: "4px" }
    : { padding: "16px", vertical_spacing: "12px" }
}
