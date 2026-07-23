import type { ArtifactType } from "@/types/artifact"

export type RichOutputRequestCategory =
  | "how-it-works-physical"
  | "how-it-works-abstract"
  | "process-steps"
  | "architecture-containment"
  | "database-schema-erd"
  | "trends-over-time"
  | "category-comparison"
  | "part-of-whole"
  | "kpis-metrics"
  | "design-a-ui"
  | "choose-between-options"
  | "cyclic-process"
  | "physics-math-simulation"
  | "function-equation-plotter"
  | "data-exploration"
  | "creative-decorative-art"
  | "3d-visualization"
  | "music-audio"
  | "network-graph"
  | "quick-factual-answer"
  | "code-solution"
  | "emotional-support"

export type RichOutputType =
  "svg" | "html" | "mermaid" | "chart" | "canvas" | "plain-text" | "code" | "warm-text"

export type RichOutputTechnology =
  "svg" | "html" | "mermaid" | "chartjs" | "canvas" | "threejs" | "tonejs" | "d3" | "none"

export type RichOutputHostStrategy =
  "native" | "artifact-preview" | "sandboxed-html" | "lazy-runtime"

export type RichOutputRolloutTier = "core" | "advanced"

export interface RichOutputProfile {
  id: RichOutputRequestCategory
  title: string
  outputType: RichOutputType
  technology: RichOutputTechnology
  hostStrategy: RichOutputHostStrategy
  artifactType: ArtifactType
  fallbackId: RichOutputRequestCategory
  rolloutTier: RichOutputRolloutTier
}

export interface RichOutputFeatureFlags {
  enableAdvancedRichOutputProfiles?: boolean
}

export interface RichOutputRoutingOptions {
  preferSimpleOutput?: boolean
  supportsRichOutput?: boolean
  featureFlags?: RichOutputFeatureFlags
}

export type RichOutputRoutingReason =
  "feature-disabled" | "prefer-simple-output" | "rich-output-disabled"

export interface RichOutputRoutingResult {
  requestedProfile: RichOutputProfile
  profile: RichOutputProfile
  usedFallback: boolean
  reason?: RichOutputRoutingReason
}

const SIMPLE_TEXT_PROFILE_ID: RichOutputRequestCategory = "quick-factual-answer"

export const RICH_OUTPUT_PROFILES: Record<RichOutputRequestCategory, RichOutputProfile> = {
  "how-it-works-physical": {
    id: "how-it-works-physical",
    title: "Illustrative Diagram",
    outputType: "svg",
    technology: "svg",
    hostStrategy: "artifact-preview",
    artifactType: "svg",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "how-it-works-abstract": {
    id: "how-it-works-abstract",
    title: "Interactive Explainer",
    outputType: "html",
    technology: "html",
    hostStrategy: "sandboxed-html",
    artifactType: "html",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "process-steps": {
    id: "process-steps",
    title: "Process Flowchart",
    outputType: "svg",
    technology: "svg",
    hostStrategy: "artifact-preview",
    artifactType: "svg",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "architecture-containment": {
    id: "architecture-containment",
    title: "Structural Diagram",
    outputType: "svg",
    technology: "svg",
    hostStrategy: "artifact-preview",
    artifactType: "svg",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "database-schema-erd": {
    id: "database-schema-erd",
    title: "Relationship Diagram",
    outputType: "mermaid",
    technology: "mermaid",
    hostStrategy: "artifact-preview",
    artifactType: "mermaid",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "trends-over-time": {
    id: "trends-over-time",
    title: "Trend Chart",
    outputType: "chart",
    technology: "chartjs",
    hostStrategy: "lazy-runtime",
    artifactType: "chart",
    fallbackId: "kpis-metrics",
    rolloutTier: "advanced",
  },
  "category-comparison": {
    id: "category-comparison",
    title: "Comparison Chart",
    outputType: "chart",
    technology: "chartjs",
    hostStrategy: "lazy-runtime",
    artifactType: "chart",
    fallbackId: "choose-between-options",
    rolloutTier: "advanced",
  },
  "part-of-whole": {
    id: "part-of-whole",
    title: "Share Chart",
    outputType: "chart",
    technology: "chartjs",
    hostStrategy: "lazy-runtime",
    artifactType: "chart",
    fallbackId: "kpis-metrics",
    rolloutTier: "advanced",
  },
  "kpis-metrics": {
    id: "kpis-metrics",
    title: "Metric Dashboard",
    outputType: "html",
    technology: "html",
    hostStrategy: "sandboxed-html",
    artifactType: "html",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "design-a-ui": {
    id: "design-a-ui",
    title: "UI Mockup",
    outputType: "html",
    technology: "html",
    hostStrategy: "sandboxed-html",
    artifactType: "html",
    fallbackId: "choose-between-options",
    rolloutTier: "core",
  },
  "choose-between-options": {
    id: "choose-between-options",
    title: "Comparison Grid",
    outputType: "html",
    technology: "html",
    hostStrategy: "sandboxed-html",
    artifactType: "html",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "cyclic-process": {
    id: "cyclic-process",
    title: "Step-through Cycle",
    outputType: "html",
    technology: "html",
    hostStrategy: "sandboxed-html",
    artifactType: "html",
    fallbackId: "process-steps",
    rolloutTier: "core",
  },
  "physics-math-simulation": {
    id: "physics-math-simulation",
    title: "Physics Simulation",
    outputType: "canvas",
    technology: "canvas",
    hostStrategy: "lazy-runtime",
    artifactType: "html",
    fallbackId: "function-equation-plotter",
    rolloutTier: "advanced",
  },
  "function-equation-plotter": {
    id: "function-equation-plotter",
    title: "Function Plotter",
    outputType: "svg",
    technology: "svg",
    hostStrategy: "artifact-preview",
    artifactType: "svg",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "data-exploration": {
    id: "data-exploration",
    title: "Sortable Table",
    outputType: "html",
    technology: "html",
    hostStrategy: "sandboxed-html",
    artifactType: "html",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "creative-decorative-art": {
    id: "creative-decorative-art",
    title: "Decorative Illustration",
    outputType: "svg",
    technology: "svg",
    hostStrategy: "artifact-preview",
    artifactType: "svg",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "3d-visualization": {
    id: "3d-visualization",
    title: "3D Scene",
    outputType: "html",
    technology: "threejs",
    hostStrategy: "lazy-runtime",
    artifactType: "html",
    fallbackId: "creative-decorative-art",
    rolloutTier: "advanced",
  },
  "music-audio": {
    id: "music-audio",
    title: "Audio Synthesizer",
    outputType: "html",
    technology: "tonejs",
    hostStrategy: "lazy-runtime",
    artifactType: "html",
    fallbackId: "emotional-support",
    rolloutTier: "advanced",
  },
  "network-graph": {
    id: "network-graph",
    title: "Force Layout",
    outputType: "html",
    technology: "d3",
    hostStrategy: "lazy-runtime",
    artifactType: "html",
    fallbackId: "choose-between-options",
    rolloutTier: "advanced",
  },
  "quick-factual-answer": {
    id: "quick-factual-answer",
    title: "Plain Text Answer",
    outputType: "plain-text",
    technology: "none",
    hostStrategy: "native",
    artifactType: "document",
    fallbackId: "quick-factual-answer",
    rolloutTier: "core",
  },
  "code-solution": {
    id: "code-solution",
    title: "Code Solution",
    outputType: "code",
    technology: "none",
    hostStrategy: "native",
    artifactType: "code",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
  "emotional-support": {
    id: "emotional-support",
    title: "Warm Support Response",
    outputType: "warm-text",
    technology: "none",
    hostStrategy: "native",
    artifactType: "document",
    fallbackId: SIMPLE_TEXT_PROFILE_ID,
    rolloutTier: "core",
  },
}

export function listRichOutputProfiles(): RichOutputProfile[] {
  return Object.values(RICH_OUTPUT_PROFILES)
}

export function getRichOutputProfile(id: RichOutputRequestCategory): RichOutputProfile | undefined {
  return RICH_OUTPUT_PROFILES[id]
}

function isAdvancedProfileEnabled(options?: RichOutputRoutingOptions): boolean {
  return options?.featureFlags?.enableAdvancedRichOutputProfiles !== false
}

function resolveFallbackProfile(
  profile: RichOutputProfile,
  reason: RichOutputRoutingReason
): RichOutputRoutingResult {
  const fallback =
    getRichOutputProfile(profile.fallbackId) ?? RICH_OUTPUT_PROFILES[SIMPLE_TEXT_PROFILE_ID]

  return {
    requestedProfile: profile,
    profile: fallback,
    usedFallback: true,
    reason,
  }
}

export function routeRichOutputProfile(
  category: RichOutputRequestCategory,
  options?: RichOutputRoutingOptions
): RichOutputRoutingResult {
  const requestedProfile =
    getRichOutputProfile(category) ?? RICH_OUTPUT_PROFILES[SIMPLE_TEXT_PROFILE_ID]

  if (options?.preferSimpleOutput) {
    return {
      requestedProfile,
      profile: RICH_OUTPUT_PROFILES[SIMPLE_TEXT_PROFILE_ID],
      usedFallback: true,
      reason: "prefer-simple-output",
    }
  }

  if (options?.supportsRichOutput === false) {
    return resolveFallbackProfile(requestedProfile, "rich-output-disabled")
  }

  if (requestedProfile.rolloutTier === "advanced" && !isAdvancedProfileEnabled(options)) {
    return resolveFallbackProfile(requestedProfile, "feature-disabled")
  }

  return {
    requestedProfile,
    profile: requestedProfile,
    usedFallback: false,
  }
}
