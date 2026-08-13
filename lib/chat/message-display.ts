import {
  isAgentFlowMode,
  type AgentFlowMode,
  type MessageActionVisibility,
  type MessageDisplayLayout,
  type MessageDisplayMetadataOptions,
  type MessageDisplayPreferences,
  type MessageDisplayPreset,
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
    actions: "core",
    agentFlowMode: "simplified",
    reasoning: "collapsed",
    tools: "auto",
    sources: "collapsed",
    richControls: "hover",
    motion: "restrained",
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
    actions: "core",
    agentFlowMode: "standard",
    reasoning: "auto",
    tools: "auto",
    sources: "collapsed",
    richControls: "hover",
    motion: "restrained",
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
