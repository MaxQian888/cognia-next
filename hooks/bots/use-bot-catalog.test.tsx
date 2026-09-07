/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import type { BotDefinitionRow, BotInstallationRow } from "@/lib/db/bot-types"
import type { RegisteredBot } from "@/lib/plugin/registries/bot-registry"
import type { Plugin } from "@/types/plugin"

let liveDeps: unknown[] = []
let liveValue: unknown
let lastRead: (() => unknown) | undefined
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (read: () => unknown, deps: unknown[]) => {
    liveDeps = deps
    // Exercised on demand by the tests that care, so a wrong read cannot sit
    // green behind a mock that never calls it.
    lastRead = read
    return liveValue
  },
}))

const listBotDefinitions = jest.fn(async (_options?: { workspaceId?: string }) => {
  return [] as BotDefinitionRow[]
})
const listBotInstallations = jest.fn(async () => [] as BotInstallationRow[])
const listBotEntries = jest.fn(
  () => [] as Array<{ id: string; entry: RegisteredBot; pluginId?: string }>
)

jest.mock("@/lib/db/bot-definitions", () => ({
  listBotDefinitions: (options?: { workspaceId?: string }) => listBotDefinitions(options),
}))
jest.mock("@/lib/db/bot-installations", () => ({
  listBotInstallations: () => listBotInstallations(),
}))
jest.mock("@/lib/plugin/registries/bot-registry", () => ({
  listBotEntries: () => listBotEntries(),
}))

let plugins: Record<string, Plugin> = {}
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: (selector: (state: unknown) => unknown) => selector({ plugins }),
}))

import { useBotCatalog } from "./use-bot-catalog"

function registered(id: string): { id: string; entry: RegisteredBot; pluginId: string } {
  return {
    id,
    pluginId: id.split(":")[0]!,
    entry: {
      id,
      definition: {
        id: "digest",
        name: "Digest",
        version: "1.0.0",
        executor: "workflow",
        workflow: "wf_1",
        triggers: [],
      } as RegisteredBot["definition"],
    },
  }
}

function installation(definitionId: string): BotInstallationRow {
  return {
    id: `boti_${definitionId}`,
    definitionId,
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: {},
    credentialBindings: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

beforeEach(() => {
  liveValue = undefined
  lastRead = undefined
  plugins = {}
  listBotDefinitions.mockClear().mockResolvedValue([])
  listBotInstallations.mockClear().mockResolvedValue([])
  listBotEntries.mockClear().mockReturnValue([])
})

describe("useBotCatalog", () => {
  it("reports loading until the first read resolves, apart from an empty catalogue", () => {
    const { result, rerender } = renderHook(() => useBotCatalog())
    expect(result.current).toEqual({ entries: [], loading: true })

    liveValue = []
    rerender()
    expect(result.current).toEqual({ entries: [], loading: false })
  })

  it("re-runs when the set of enabled plugins changes, not only when Dexie does", async () => {
    // A plugin's definitions live in the registry overlay, which no Dexie live
    // query will ever re-run for. Without this key the picker would keep
    // offering Bots from a plugin that had just been switched off.
    renderHook(() => useBotCatalog())
    expect(liveDeps).toEqual(["", undefined])

    plugins = { acme: { status: "enabled" } as Plugin }
    renderHook(() => useBotCatalog())
    expect(liveDeps).toEqual(["acme", undefined])
  })

  it("samples the registry inside the read, so the counts match the list", async () => {
    listBotEntries.mockReturnValue([registered("acme:digest")])
    listBotInstallations.mockResolvedValue([installation("acme:digest")])
    renderHook(() => useBotCatalog())
    const entries = (await lastRead?.()) as Array<{ definitionId: string; installedCount: number }>
    expect(entries).toEqual([
      expect.objectContaining({ definitionId: "acme:digest", installedCount: 1 }),
    ])
  })

  it("narrows the local definitions to a workspace when one is given", async () => {
    renderHook(() => useBotCatalog({ workspaceId: "ws_1" }))
    await lastRead?.()
    expect(listBotDefinitions).toHaveBeenCalledWith({ workspaceId: "ws_1" })
  })

  it("asks for every local definition when no workspace is named", async () => {
    renderHook(() => useBotCatalog())
    await lastRead?.()
    expect(listBotDefinitions).toHaveBeenCalledWith({})
  })
})
