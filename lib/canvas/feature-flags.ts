export type CanvasFeatureFlag =
  "canvas.aiWorkbench.v1" | "canvas.collaboration.v1" | "contextWorkbench.v1"

const CANVAS_FEATURE_FLAGS_KEY = "cognia-canvas-feature-flags-v1"

const DEFAULT_CANVAS_FEATURE_FLAGS: Record<CanvasFeatureFlag, boolean> = {
  "canvas.aiWorkbench.v1": true,
  "canvas.collaboration.v1": true,
  "contextWorkbench.v1": true,
}

function readStoredCanvasFeatureFlags(): Partial<Record<CanvasFeatureFlag, boolean>> {
  if (typeof window === "undefined") {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(CANVAS_FEATURE_FLAGS_KEY)
    if (!raw) {
      return {}
    }

    const parsed = JSON.parse(raw) as Partial<Record<CanvasFeatureFlag, unknown>>
    const result: Partial<Record<CanvasFeatureFlag, boolean>> = {}
    if (typeof parsed["canvas.aiWorkbench.v1"] === "boolean") {
      result["canvas.aiWorkbench.v1"] = parsed["canvas.aiWorkbench.v1"]
    }
    if (typeof parsed["canvas.collaboration.v1"] === "boolean") {
      result["canvas.collaboration.v1"] = parsed["canvas.collaboration.v1"]
    }
    if (typeof parsed["contextWorkbench.v1"] === "boolean") {
      result["contextWorkbench.v1"] = parsed["contextWorkbench.v1"]
    }
    return result
  } catch {
    return {}
  }
}

function readEnvCanvasFeatureFlags(): Partial<Record<CanvasFeatureFlag, boolean>> {
  const result: Partial<Record<CanvasFeatureFlag, boolean>> = {}
  const aiWorkbench = process.env.NEXT_PUBLIC_CANVAS_AI_WORKBENCH_V1
  const collaboration = process.env.NEXT_PUBLIC_CANVAS_COLLABORATION_V1
  const contextWorkbench = process.env.NEXT_PUBLIC_CONTEXT_WORKBENCH_V1

  if (aiWorkbench === "0" || aiWorkbench === "false") {
    result["canvas.aiWorkbench.v1"] = false
  } else if (aiWorkbench === "1" || aiWorkbench === "true") {
    result["canvas.aiWorkbench.v1"] = true
  }

  if (collaboration === "0" || collaboration === "false") {
    result["canvas.collaboration.v1"] = false
  } else if (collaboration === "1" || collaboration === "true") {
    result["canvas.collaboration.v1"] = true
  }

  if (contextWorkbench === "0" || contextWorkbench === "false") {
    result["contextWorkbench.v1"] = false
  } else if (contextWorkbench === "1" || contextWorkbench === "true") {
    result["contextWorkbench.v1"] = true
  }

  return result
}

export function getCanvasFeatureFlags(): Record<CanvasFeatureFlag, boolean> {
  return {
    ...DEFAULT_CANVAS_FEATURE_FLAGS,
    ...readEnvCanvasFeatureFlags(),
    ...readStoredCanvasFeatureFlags(),
  }
}

export function isCanvasFeatureFlagEnabled(flag: CanvasFeatureFlag): boolean {
  return getCanvasFeatureFlags()[flag]
}
