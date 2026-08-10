import { BYOKProvider } from "@cognia/provider-types"

/**
 * OpenRouter configuration helpers and constants
 * Extracted from components/settings/provider/openrouter-settings.tsx
 */

interface BYOKProviderConfig {
  id: BYOKProvider
  name: string
  description: string
  configType: "simple" | "azure" | "bedrock" | "vertex"
}
declare const BYOK_PROVIDERS: BYOKProviderConfig[]
declare function getConfigPlaceholder(configType?: string): string
declare function getConfigHelp(configType?: string): string

export { type BYOKProviderConfig, BYOK_PROVIDERS, getConfigHelp, getConfigPlaceholder }
