/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { Plugin } from "@/types/plugin"

let liveDeps: unknown[] = []
let liveValue: unknown
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (read: () => unknown, deps: unknown[]) => {
    liveDeps = deps
    // The closure is exercised on demand by the tests that care, so a wrong
    // read cannot sit green behind a mock that never calls it.
    lastRead = read
    return liveValue
  },
}))

let lastRead: (() => unknown) | undefined

const listBotInstallations = jest.fn(async (): Promise<BotInstallationRow[]> => [])
const listBotDeliveries = jest.fn(async () => [] as unknown[])
const resolveInstalledBot = jest.fn(async (_row: BotInstallationRow) => null)

jest.mock("@/lib/db/bot-installations", () => ({
  listBotInstallations: (...args: unknown[]) => listBotInstallations(...(args as [])),
  // The row model imports these two, and they are pure.
  isBotTriggerArmed: jest.requireActual("@/lib/db/bot-installations").isBotTriggerArmed,
  unboundCredentialSlots: jest.requireActual("@/lib/db/bot-installations").unboundCredentialSlots,
}))
jest.mock("@/lib/db/bot-event-deliveries", () => ({
  listBotDeliveries: (...args: unknown[]) => listBotDeliveries(...(args as [])),
}))
jest.mock("@/lib/bot/installed-bot", () => ({
  resolveInstalledBot: (row: BotInstallationRow) => resolveInstalledBot(row),
}))

let plugins: Record<string, Plugin> = {}
jest.mock("@/stores/plugin-runtime/plugin-store", () => ({
  usePluginStore: (selector: (state: unknown) => unknown) => selector({ plugins }),
}))

import { enabledPluginKey, useBotInstallations } from "./use-bot-installations"

function installation(over: Partial<BotInstallationRow> = {}): BotInstallationRow {
  return {
    id: "boti_1",
    definitionId: "acme:review",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: {},
    credentialBindings: {},
    createdAt: 1,
    updatedAt: 10,
    ...over,
  }
}

beforeEach(() => {
  liveValue = undefined
  liveDeps = []
  lastRead = undefined
  plugins = {}
  listBotInstallations.mockReset().mockResolvedValue([])
  listBotDeliveries.mockReset().mockResolvedValue([])
  resolveInstalledBot.mockReset().mockResolvedValue(null)
})

describe("enabledPluginKey", () => {
  it("changes when a plugin is disabled, and not when the load order shuffles", () => {
    const a = { id: "a", status: "enabled" } as Plugin
    const b = { id: "b", status: "enabled" } as Plugin
    expect(enabledPluginKey({ a, b })).toBe("a,b")
    expect(enabledPluginKey({ b, a })).toBe("a,b")
    expect(enabledPluginKey({ a, b: { ...b, status: "disabled" } as Plugin })).toBe("a")
  })
})

describe("useBotInstallations", () => {
  it("re-reads when the enabled plugin set changes, not only when Dexie does", () => {
    // A plugin's definitions live in the registry overlay, which no Dexie
    // query watches. Without this dependency a disabled plugin left its Bots
    // on screen looking healthy.
    plugins = { a: { id: "a", status: "enabled" } as Plugin }
    renderHook(() => useBotInstallations())
    expect(liveDeps).toEqual(["a"])
  })

  it("reports loading until the first read resolves, distinctly from empty", () => {
    const { result, rerender } = renderHook(() => useBotInstallations())
    expect(result.current.loading).toBe(true)
    expect(result.current.rows).toEqual([])

    liveValue = []
    rerender()
    expect(result.current.loading).toBe(false)
  })

  it("joins installations, resolutions and dead letters into rows", async () => {
    listBotInstallations.mockResolvedValue([installation()])
    listBotDeliveries.mockResolvedValue([
      { installationId: "boti_1", status: "deadletter" },
      { installationId: "boti_1", status: "deadletter" },
    ])
    renderHook(() => useBotInstallations())

    const rows = (await lastRead?.()) as Array<{ id: string; deadLetters: number }>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: "boti_1", deadLetters: 2, orphaned: true })
    expect(listBotDeliveries).toHaveBeenCalledWith({ status: "deadletter", limit: 500 })
  })

  it("keeps an installation whose definition is gone", async () => {
    listBotInstallations.mockResolvedValue([installation()])
    resolveInstalledBot.mockResolvedValue(null)
    renderHook(() => useBotInstallations())

    const rows = (await lastRead?.()) as Array<{ orphaned: boolean }>
    expect(rows[0].orphaned).toBe(true)
  })

  it("summarizes the rows it has", () => {
    liveValue = [
      {
        id: "a",
        status: "enabled",
        orphaned: false,
        problems: [],
        armedTriggers: 1,
        deadLetters: 0,
      },
      {
        id: "b",
        status: "needs_setup",
        orphaned: false,
        problems: [],
        armedTriggers: 0,
        deadLetters: 2,
      },
    ]
    const { result } = renderHook(() => useBotInstallations())
    expect(result.current.summary).toEqual({
      total: 2,
      armed: 1,
      needsAttention: 1,
      deadLetters: 2,
    })
  })
})
