import type { CustomModeConfig } from "./definitions"

export const initialState = {
  customModes: {} as Record<string, CustomModeConfig>,
  activeModeId: null as string | null,
  isGenerating: false,
  generationError: null as string | null,
}
