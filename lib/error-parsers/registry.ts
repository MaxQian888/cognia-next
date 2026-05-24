import type { ErrorPreset } from "./types"

let defaultPreset: ErrorPreset | null = null
const toolPresets = new Map<string, ErrorPreset>()

export function registerDefaultPreset(preset: ErrorPreset): void {
  defaultPreset = preset
}

export function registerToolPreset(toolType: string, preset: ErrorPreset): void {
  toolPresets.set(toolType, preset)
}

export function resolvePreset(toolType?: string): ErrorPreset {
  if (toolType && toolPresets.has(toolType)) {
    return toolPresets.get(toolType)!
  }
  if (defaultPreset) {
    return defaultPreset
  }
  return {
    name: "identity",
    parsers: [],
    parse(text: string) {
      return {
        nodes: [{ kind: "text" as const, content: text }],
        parsed: false,
      }
    },
  }
}
