import {
  __resetCharacterPacksForTesting,
  getCharacterPack,
  registerCharacterPack,
} from "@/lib/plugin/registries/character-pack-registry"
import type { PluginCharacterPackDef } from "@cognia/plugin-sdk/api/character-pack"
import { createCharacterPacksAPI } from "./character-packs-api"

const pack: PluginCharacterPackDef = {
  id: "support",
  name: "Support",
  version: "1.0.0",
  characters: [
    {
      localId: "triage",
      name: "Triage",
      avatarColor: "blue",
      systemPrompt: "Triage requests.",
    },
  ],
}

describe("createCharacterPacksAPI", () => {
  afterEach(() => __resetCharacterPacksForTesting())

  it("registers, lists, reads, and unregisters a plugin-owned pack", () => {
    const api = createCharacterPacksAPI("acme")
    const registration = api.register(pack)

    expect(api.listRegistered()).toEqual([pack.id])
    expect(api.get(pack.id)).toBe(pack)
    expect(registration.packId).toBe(pack.id)

    registration.unregister()
    expect(getCharacterPack(pack.id)).toBeUndefined()
  })

  it("does not remove a replacement owned by another plugin", () => {
    const registration = createCharacterPacksAPI("acme").register(pack)
    registerCharacterPack(pack.id, { ...pack, name: "Replacement" }, { pluginId: "other" })

    registration.unregister()
    expect(getCharacterPack(pack.id)?.name).toBe("Replacement")
  })

  it("rejects collisions with another owner", () => {
    registerCharacterPack(pack.id, pack, { pluginId: "other" })
    expect(() => createCharacterPacksAPI("acme").register(pack)).toThrow(
      'pack id "support" is already owned by plugin "other"'
    )
  })
})
