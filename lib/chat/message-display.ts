import {
  isAgentFlowMode,
  isChatCodeThemeId,
  isMessageBlockDensity,
  isMessageBodyFont,
  isMessageCodeMaxHeight,
  isMessageLinkColor,
  isMessageLinkPreview,
  isMessageLinkUnderline,
  isMessageMathAlign,
  isMessageMathFontScale,
  isMessageSpacing,
  isMessageTextSize,
  type AgentFlowMode,
  type MessageActionVisibility,
  type MessageBodyFont,
  type MessageDisplayLayout,
  type MessageDisplayMetadataOptions,
  type MessageDisplayPreferences,
  type MessageDisplayPreset,
  type MessageLinkOptions,
  type MessageMarkdownOptions,
  type MessageReadingOptions,
  type MessageMotion,
  type MessagePartVisibility,
  type MessageRichControls,
} from "@/types/appearance"

export interface ResolvedMessageDisplayOptions {
  preset: MessageDisplayPreset
  layout: MessageDisplayLayout
  metadata: MessageDisplayMetadataOptions
  actions: MessageActionVisibility
  agentFlowMode: AgentFlowMode
  reasoning: MessagePartVisibility
  tools: MessagePartVisibility
  sources: MessagePartVisibility
  richControls: MessageRichControls
  motion: MessageMotion
  /** ADR-0127 — fully resolved markdown / code / math knobs (both renderers read this). */
  markdown: MessageMarkdownOptions
  /** ADR-0127 — body-copy font for message prose. */
  bodyFont: MessageBodyFont
  /** ADR-0218 — prose size and spacing. */
  reading: MessageReadingOptions
  /** ADR-0218 — link colour, underline, site mark and previews. */
  links: MessageLinkOptions
}

/**
 * The renderer behaviour every preset shipped with before ADR-0127 made these
 * user-configurable — identical across presets on purpose so upgrading does
 * not change what anyone sees until they touch a knob.
 */
export const DEFAULT_MESSAGE_MARKDOWN_OPTIONS: MessageMarkdownOptions = {
  math: true,
  mermaid: true,
  diff: true,
  codeLineNumbers: true,
  codeWrap: false,
  mathFontScale: 1,
  mathAlign: "center",
  mathCopy: true,
  charts: true,
  blockDensity: "compact",
  blockBorder: true,
  blockHeader: true,
  codeMaxHeight: "tall",
  codeTheme: "one",
}

/**
 * ADR-0218 — `md` / `comfortable` are exactly the size and rhythm chat had
 * before these became settings, so nothing moves until someone picks another.
 */
export const DEFAULT_MESSAGE_READING_OPTIONS: MessageReadingOptions = {
  textSize: "md",
  spacing: "comfortable",
}

/**
 * ADR-0218 — the one deliberate default change: links take the `--link` token
 * instead of the neutral `--primary`, and external links carry a site mark.
 */
export const DEFAULT_MESSAGE_LINK_OPTIONS: MessageLinkOptions = {
  color: "link",
  underline: "subtle",
  siteIcon: true,
  preview: "hover",
}

const PRESETS: Record<MessageDisplayPreset, ResolvedMessageDisplayOptions> = {
  focused: {
    preset: "focused",
    layout: "hybrid",
    metadata: {
      identity: "header",
      timestamp: "header",
      model: "details",
      provider: "hidden",
      duration: "hidden",
      usage: "hidden",
      cost: "hidden",
      finishState: "details",
    },
    // Hover-revealed, not always-on: the row's own chrome is not content, and a
    // permanent strip of icon buttons under every message is what the reading
    // area reads as noise. `HOVER_REVEAL_CLASS` keeps it reachable by focus and
    // on touch, so hiding it costs no reach.
    actions: "hover",
    agentFlowMode: "simplified",
    reasoning: "collapsed",
    tools: "auto",
    sources: "collapsed",
    richControls: "hover",
    motion: "restrained",
    markdown: DEFAULT_MESSAGE_MARKDOWN_OPTIONS,
    bodyFont: "sans",
    reading: DEFAULT_MESSAGE_READING_OPTIONS,
    links: DEFAULT_MESSAGE_LINK_OPTIONS,
  },
  balanced: {
    preset: "balanced",
    layout: "hybrid",
    metadata: {
      identity: "header",
      timestamp: "header",
      model: "header",
      provider: "details",
      duration: "details",
      usage: "details",
      cost: "details",
      finishState: "details",
    },
    // Hover-revealed for the same reason `focused` is.
    actions: "hover",
    agentFlowMode: "standard",
    reasoning: "auto",
    tools: "auto",
    sources: "collapsed",
    richControls: "hover",
    motion: "restrained",
    markdown: DEFAULT_MESSAGE_MARKDOWN_OPTIONS,
    bodyFont: "sans",
    reading: DEFAULT_MESSAGE_READING_OPTIONS,
    links: DEFAULT_MESSAGE_LINK_OPTIONS,
  },
  inspector: {
    preset: "inspector",
    layout: "hybrid",
    metadata: {
      identity: "header",
      timestamp: "header",
      model: "header",
      provider: "header",
      duration: "header",
      usage: "details",
      cost: "details",
      finishState: "header",
    },
    actions: "all",
    agentFlowMode: "detailed",
    reasoning: "expanded",
    tools: "expanded",
    sources: "expanded",
    richControls: "always",
    motion: "restrained",
    markdown: DEFAULT_MESSAGE_MARKDOWN_OPTIONS,
    bodyFont: "sans",
    reading: DEFAULT_MESSAGE_READING_OPTIONS,
    links: DEFAULT_MESSAGE_LINK_OPTIONS,
  },
}

export const DEFAULT_MESSAGE_DISPLAY_OPTIONS = PRESETS.balanced

const isPreset = (value: unknown): value is MessageDisplayPreset =>
  value === "focused" || value === "balanced" || value === "inspector"
const isLayout = (value: unknown): value is MessageDisplayLayout =>
  value === "hybrid" || value === "bubbles" || value === "cards"
const isPlacement = (
  value: unknown
): value is MessageDisplayMetadataOptions[keyof MessageDisplayMetadataOptions] =>
  value === "hidden" || value === "header" || value === "details"
const isActions = (value: unknown): value is MessageActionVisibility =>
  value === "hover" || value === "core" || value === "all"
const isPartVisibility = (value: unknown): value is MessagePartVisibility =>
  value === "hidden" || value === "collapsed" || value === "auto" || value === "expanded"
const isRichControls = (value: unknown): value is MessageRichControls =>
  value === "hidden" || value === "hover" || value === "always"
const isMotion = (value: unknown): value is MessageMotion =>
  value === "off" || value === "restrained" || value === "expressive"

function applyPreferences(
  current: ResolvedMessageDisplayOptions,
  preferences: MessageDisplayPreferences | undefined
): ResolvedMessageDisplayOptions {
  if (!preferences || !isPreset(preferences.preset)) return current
  const base = PRESETS[preferences.preset]
  const overrides = preferences.overrides
  if (!overrides) return base
  const metadata = { ...base.metadata }
  if (overrides.metadata) {
    for (const key of Object.keys(metadata) as Array<keyof MessageDisplayMetadataOptions>) {
      const value = overrides.metadata[key]
      if (isPlacement(value)) metadata[key] = value
    }
  }
  return {
    ...base,
    metadata,
    layout: isLayout(overrides.layout) ? overrides.layout : base.layout,
    actions: isActions(overrides.actions) ? overrides.actions : base.actions,
    agentFlowMode: isAgentFlowMode(overrides.agentFlowMode)
      ? overrides.agentFlowMode
      : base.agentFlowMode,
    reasoning: isPartVisibility(overrides.reasoning) ? overrides.reasoning : base.reasoning,
    tools: isPartVisibility(overrides.tools) ? overrides.tools : base.tools,
    sources: isPartVisibility(overrides.sources) ? overrides.sources : base.sources,
    richControls: isRichControls(overrides.richControls)
      ? overrides.richControls
      : base.richControls,
    motion: isMotion(overrides.motion) ? overrides.motion : base.motion,
    markdown: resolveMarkdownOverrides(base.markdown, overrides.markdown),
    bodyFont: isMessageBodyFont(overrides.bodyFont) ? overrides.bodyFont : base.bodyFont,
    reading: resolveReadingOverrides(base.reading, overrides.reading),
    links: resolveLinkOverrides(base.links, overrides.links),
  }
}

function resolveReadingOverrides(
  base: MessageReadingOptions,
  overrides: Partial<MessageReadingOptions> | undefined
): MessageReadingOptions {
  if (!overrides) return base
  return {
    textSize: isMessageTextSize(overrides.textSize) ? overrides.textSize : base.textSize,
    spacing: isMessageSpacing(overrides.spacing) ? overrides.spacing : base.spacing,
  }
}

function resolveLinkOverrides(
  base: MessageLinkOptions,
  overrides: Partial<MessageLinkOptions> | undefined
): MessageLinkOptions {
  if (!overrides) return base
  return {
    color: isMessageLinkColor(overrides.color) ? overrides.color : base.color,
    underline: isMessageLinkUnderline(overrides.underline) ? overrides.underline : base.underline,
    siteIcon: isBool(overrides.siteIcon) ? overrides.siteIcon : base.siteIcon,
    preview: isMessageLinkPreview(overrides.preview) ? overrides.preview : base.preview,
  }
}

const isBool = (value: unknown): value is boolean => typeof value === "boolean"

function resolveMarkdownOverrides(
  base: MessageMarkdownOptions,
  overrides: Partial<MessageMarkdownOptions> | undefined
): MessageMarkdownOptions {
  if (!overrides) return base
  return {
    math: isBool(overrides.math) ? overrides.math : base.math,
    mermaid: isBool(overrides.mermaid) ? overrides.mermaid : base.mermaid,
    diff: isBool(overrides.diff) ? overrides.diff : base.diff,
    codeLineNumbers: isBool(overrides.codeLineNumbers)
      ? overrides.codeLineNumbers
      : base.codeLineNumbers,
    codeWrap: isBool(overrides.codeWrap) ? overrides.codeWrap : base.codeWrap,
    mathFontScale: isMessageMathFontScale(overrides.mathFontScale)
      ? overrides.mathFontScale
      : base.mathFontScale,
    mathAlign: isMessageMathAlign(overrides.mathAlign) ? overrides.mathAlign : base.mathAlign,
    mathCopy: isBool(overrides.mathCopy) ? overrides.mathCopy : base.mathCopy,
    charts: isBool(overrides.charts) ? overrides.charts : base.charts,
    blockDensity: isMessageBlockDensity(overrides.blockDensity)
      ? overrides.blockDensity
      : base.blockDensity,
    blockBorder: isBool(overrides.blockBorder) ? overrides.blockBorder : base.blockBorder,
    blockHeader: isBool(overrides.blockHeader) ? overrides.blockHeader : base.blockHeader,
    codeMaxHeight: isMessageCodeMaxHeight(overrides.codeMaxHeight)
      ? overrides.codeMaxHeight
      : base.codeMaxHeight,
    codeTheme: isChatCodeThemeId(overrides.codeTheme) ? overrides.codeTheme : base.codeTheme,
  }
}

export function resolveMessageDisplayOptions(
  global?: MessageDisplayPreferences,
  session?: MessageDisplayPreferences,
  legacyAgentFlow?: unknown
): ResolvedMessageDisplayOptions {
  let resolved = applyPreferences(DEFAULT_MESSAGE_DISPLAY_OPTIONS, global)
  if (
    !global?.overrides?.agentFlowMode &&
    !session?.overrides?.agentFlowMode &&
    isAgentFlowMode(legacyAgentFlow)
  ) {
    resolved = { ...resolved, agentFlowMode: legacyAgentFlow }
  }
  return applyPreferences(resolved, session)
}
