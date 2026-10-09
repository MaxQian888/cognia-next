/**
 * @jest-environment jsdom
 */

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() }
jest.mock("sonner", () => ({
  get toast() {
    return mockToast
  },
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const mockDb = {
  duplicateCharacter: jest.fn(),
  createCharacterVariant: jest.fn(),
  detachCharacterVariant: jest.fn(),
  resetCharacterVariant: jest.fn(),
  deleteCharacter: jest.fn(),
  dismissPackUpdate: jest.fn(),
  applyPackUpdate: jest.fn(),
  applyPackUpdateForPack: jest.fn(),
}
jest.mock("@/lib/db/characters", () => {
  class CharacterHasVariantsError extends Error {
    variantNames: string[]
    constructor(id: string, names: string[]) {
      super(id)
      this.variantNames = names
    }
  }
  return {
    CharacterHasVariantsError,
    duplicateCharacter: (...a: unknown[]) => mockDb.duplicateCharacter(...a),
    createCharacterVariant: (...a: unknown[]) => mockDb.createCharacterVariant(...a),
    detachCharacterVariant: (...a: unknown[]) => mockDb.detachCharacterVariant(...a),
    resetCharacterVariant: (...a: unknown[]) => mockDb.resetCharacterVariant(...a),
    deleteCharacter: (...a: unknown[]) => mockDb.deleteCharacter(...a),
    dismissPackUpdate: (...a: unknown[]) => mockDb.dismissPackUpdate(...a),
    applyPackUpdate: (...a: unknown[]) => mockDb.applyPackUpdate(...a),
    applyPackUpdateForPack: (...a: unknown[]) => mockDb.applyPackUpdateForPack(...a),
  }
})

const mockDownloadBlob = jest.fn(async (..._a: unknown[]) => ({ kind: "downloaded" }))
jest.mock("@/lib/files/download", () => ({
  downloadBlob: (...a: unknown[]) => mockDownloadBlob(...a),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

const mockExportPack = jest.fn()
jest.mock("@/lib/plugin/character-pack/local-pack-store", () => ({
  LOCAL_PACK_PLUGIN_ID: "local-pack",
  exportPack: (...a: unknown[]) => mockExportPack(...a),
}))

import { act, renderHook } from "@testing-library/react"
import type { Character } from "@cognia/agent-config-types"
import { useAgentActions } from "./use-agent-actions"
import {
  __resetCharacterPacksForTesting,
  registerCharacterPack,
} from "@/lib/plugin/registries/character-pack-registry"
import { CharacterHasVariantsError } from "@/lib/db/characters"

function agent(patch: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Reviewer",
    systemPrompt: "x",
    avatarColor: "#000",
    createdAt: 0,
    updatedAt: 0,
    ...patch,
  }
}

beforeEach(() => {
  for (const fn of Object.values(mockDb)) fn.mockReset()
  for (const fn of Object.values(mockToast)) fn.mockReset()
  mockDownloadBlob.mockClear()
  mockExportPack.mockReset()
  __resetCharacterPacksForTesting()
})

describe("useAgentActions", () => {
  it("duplicates and resolves the copy to open", async () => {
    mockDb.duplicateCharacter.mockResolvedValue(agent({ id: "dup", name: "Copy" }))
    const { result } = renderHook(() => useAgentActions())
    let copy: Character | undefined
    await act(async () => {
      copy = await result.current.duplicate(agent())
    })
    expect(copy?.id).toBe("dup")
    expect(mockToast.success).toHaveBeenCalledWith("duplicatedToast")
  })

  it("creates a variant under a translated default name", async () => {
    mockDb.createCharacterVariant.mockResolvedValue(agent({ id: "v1" }))
    const { result } = renderHook(() => useAgentActions())
    await act(async () => {
      await result.current.createVariant(agent())
    })
    expect(mockDb.createCharacterVariant).toHaveBeenCalledWith("char_1", "variants.defaultName")
    expect(mockToast.success).toHaveBeenCalledWith("variants.createdToast")
  })

  it("detaches and resets variants", async () => {
    const { result } = renderHook(() => useAgentActions())
    await act(async () => {
      await result.current.detachVariant(agent())
      await result.current.resetVariant(agent())
    })
    expect(mockDb.detachCharacterVariant).toHaveBeenCalledWith("char_1")
    expect(mockDb.resetCharacterVariant).toHaveBeenCalledWith("char_1")
  })

  it("explains why a base with variants cannot be deleted", async () => {
    mockDb.deleteCharacter.mockRejectedValue(new CharacterHasVariantsError("char_1", ["Strict"]))
    const { result } = renderHook(() => useAgentActions())
    let removed = true
    await act(async () => {
      removed = await result.current.remove(agent())
    })
    expect(removed).toBe(false)
    expect(mockToast.error).toHaveBeenCalledWith("variants.deleteBlocked")
  })

  it("bulk-deletes what it can and reports the count", async () => {
    mockDb.deleteCharacter.mockImplementation(async (id: string) => {
      if (id === "builtin") throw new Error("built-in")
    })
    const { result } = renderHook(() => useAgentActions())
    let deleted = 0
    await act(async () => {
      deleted = await result.current.removeMany([agent({ id: "builtin" }), agent({ id: "b" })])
    })
    expect(deleted).toBe(1)
    expect(mockDb.deleteCharacter).toHaveBeenCalledTimes(2)
    expect(mockToast.success).toHaveBeenCalledWith("bulk.deletedToast")
  })

  it("exports the chosen agents as one pack file", () => {
    const { result } = renderHook(() => useAgentActions())
    act(() => result.current.exportMany([agent(), agent({ id: "b" })]))
    const [blob, filename] = mockDownloadBlob.mock.calls[0] as [Blob, string]
    expect(blob).toBeInstanceOf(Blob)
    expect(filename).toMatch(/\.cognia-pack\.json$/)
  })

  it("refuses to export an agent that belongs to no pack", async () => {
    const { result } = renderHook(() => useAgentActions())
    await act(async () => {
      await result.current.exportPack(agent())
    })
    expect(mockToast.error).toHaveBeenCalledWith("exportPackUnavailable")
    expect(mockExportPack).not.toHaveBeenCalled()
  })

  it("downloads the source pack of a cloned agent", async () => {
    mockExportPack.mockReturnValue({ ok: true, value: { filename: "p.json", body: "{}" } })
    const { result } = renderHook(() => useAgentActions())
    await act(async () => {
      await result.current.exportPack(agent({ sourcePluginId: "p", sourcePackId: "pack-a" }))
    })
    expect(mockExportPack).toHaveBeenCalledWith("pack-a")
    expect(mockDownloadBlob).toHaveBeenCalledWith(expect.any(Blob), "p.json")
  })

  it("re-clones from the live pack and drops the stale copy", async () => {
    mockDb.duplicateCharacter.mockResolvedValue(agent({ id: "fresh" }))
    const { result } = renderHook(() => useAgentActions())
    let fresh: Character | undefined
    await act(async () => {
      fresh = await result.current.recloneFromPack(
        agent({ clonedFromPackCharacterId: "cognia-pack:p:pack:local" })
      )
    })
    expect(mockDb.duplicateCharacter).toHaveBeenCalledWith("cognia-pack:p:pack:local")
    expect(mockDb.deleteCharacter).toHaveBeenCalledWith("char_1")
    expect(fresh?.id).toBe("fresh")
  })

  it("dismisses an update by pinning the live pack version", async () => {
    registerCharacterPack(
      "pack-a",
      { id: "pack-a", name: "Pack A", version: "3.0.0", characters: [] },
      { pluginId: "plugin-a" }
    )
    const { result } = renderHook(() => useAgentActions())
    await act(async () => {
      await result.current.dismissUpdate(
        agent({ sourcePluginId: "plugin-a", sourcePackId: "pack-a" })
      )
    })
    expect(mockDb.dismissPackUpdate).toHaveBeenCalledWith("char_1", "3.0.0")
  })

  it("applies an update after confirmation and closes the dialog", async () => {
    mockDb.applyPackUpdate.mockResolvedValue({ overwrittenFields: ["a"], preservedFields: [] })
    const { result } = renderHook(() => useAgentActions())
    act(() => result.current.requestApplyUpdate(agent()))
    expect(result.current.applyUpdateTarget?.id).toBe("char_1")
    await act(async () => {
      await result.current.confirmApplyUpdate()
    })
    expect(mockDb.applyPackUpdate).toHaveBeenCalledWith("char_1")
    expect(result.current.applyUpdateTarget).toBeNull()
    expect(mockToast.success).toHaveBeenCalledWith("applyUpdateToast")
  })

  it("applies an update to every clone of the pack at once", async () => {
    mockDb.applyPackUpdateForPack.mockResolvedValue([{}, {}])
    const { result } = renderHook(() => useAgentActions())
    await act(async () => {
      await result.current.applyUpdateForPack(
        agent({ sourcePluginId: "plugin-a", sourcePackId: "pack-a" })
      )
    })
    expect(mockDb.applyPackUpdateForPack).toHaveBeenCalledWith("plugin-a", "pack-a")
    expect(mockToast.success).toHaveBeenCalledWith("applyUpdateToastBatch")
  })
})
