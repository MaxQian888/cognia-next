/**
 * The plugin contract's share of `lib/plugin/api/character-packs-api.ts`, which re-exports these.
 */
import type { PluginCharacterPackDef } from "@cognia/plugin-sdk/api/character-pack"

export interface PluginCharacterPackRegistration {
  packId: string
  unregister(): void
}

export interface PluginCharacterPacksAPI {
  register(pack: PluginCharacterPackDef): PluginCharacterPackRegistration
  get(packId: string): PluginCharacterPackDef | undefined
  listRegistered(): string[]
}
