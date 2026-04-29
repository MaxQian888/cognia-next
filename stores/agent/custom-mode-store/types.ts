import {
  type CustomModeConfig,
  type CustomModeCategory,
  type CustomModeA2UITemplate,
  type ModeGenerationRequest,
  type GeneratedModeResult,
} from "./definitions"

export interface CustomModeState {
  // Custom modes
  customModes: Record<string, CustomModeConfig>

  // Active/selected mode
  activeModeId: string | null

  // Loading states
  isGenerating: boolean
  generationError: string | null

  // Actions - CRUD
  createMode: (mode: Partial<CustomModeConfig>) => CustomModeConfig
  updateMode: (id: string, updates: Partial<CustomModeConfig>) => void
  deleteMode: (id: string) => void
  duplicateMode: (id: string) => CustomModeConfig | null

  // Actions - Selection
  setActiveMode: (id: string | null) => void

  // Actions - Queries
  getMode: (id: string) => CustomModeConfig | undefined
  getModesByCategory: (category: CustomModeCategory) => CustomModeConfig[]
  getModesByTags: (tags: string[]) => CustomModeConfig[]
  searchModes: (query: string) => CustomModeConfig[]
  getRecentModes: (limit?: number) => CustomModeConfig[]
  getMostUsedModes: (limit?: number) => CustomModeConfig[]

  // Actions - Usage tracking
  recordModeUsage: (id: string) => void

  // Actions - A2UI Templates
  setModeA2UITemplate: (id: string, template: CustomModeA2UITemplate | undefined) => void

  // Actions - Import/Export
  exportMode: (id: string) => string | null
  importMode: (json: string) => CustomModeConfig | null
  exportAllModes: () => string
  importModes: (json: string) => number

  // Actions - Generation
  generateModeFromDescription: (request: ModeGenerationRequest) => Promise<GeneratedModeResult>
  setGenerationError: (error: string | null) => void

  // Reset
  reset: () => void
}
