import type { CustomModeState } from "./types"

export const selectCustomModes = (state: CustomModeState) => Object.values(state.customModes)

export const selectCustomModeById = (id: string) => (state: CustomModeState) =>
  state.customModes[id]

export const selectActiveCustomMode = (state: CustomModeState) =>
  state.activeModeId ? state.customModes[state.activeModeId] : undefined

export const selectIsGenerating = (state: CustomModeState) => state.isGenerating

export const selectGenerationError = (state: CustomModeState) => state.generationError

export const selectCustomModeCount = (state: CustomModeState) =>
  Object.keys(state.customModes).length
