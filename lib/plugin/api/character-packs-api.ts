import {
  getCharacterPack,
  getCharacterPackEntry,
  listCharacterPackEntries,
  registerCharacterPack,
  unregisterCharacterPackById,
} from "@/lib/plugin/registries/character-pack-registry"
import type { PluginCharacterPacksAPI } from "@cognia/plugin-contract/lib/plugin/api/character-packs-api"
export type {
  PluginCharacterPackRegistration,
  PluginCharacterPacksAPI,
} from "@cognia/plugin-contract/lib/plugin/api/character-packs-api"

export function createCharacterPacksAPI(pluginId: string): PluginCharacterPacksAPI {
  return {
    register(pack) {
      const current = getCharacterPackEntry(pack.id)
      if (current && current.pluginId !== pluginId) {
        throw new Error(
          `[character-packs-api] pack id "${pack.id}" is already owned by plugin "${current.pluginId ?? "host"}"`
        )
      }
      registerCharacterPack(pack.id, pack, { pluginId })
      return {
        packId: pack.id,
        unregister: () => {
          if (getCharacterPackEntry(pack.id)?.pluginId === pluginId) {
            unregisterCharacterPackById(pack.id)
          }
        },
      }
    },
    get: (packId) => getCharacterPack(packId),
    listRegistered: () =>
      listCharacterPackEntries()
        .filter((entry) => entry.pluginId === pluginId)
        .map((entry) => entry.id),
  }
}
