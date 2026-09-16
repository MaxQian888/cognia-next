/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import type { PluginBotDef } from "@/types/plugin/plugin-bot"
import type { BotInstallationRow } from "@/lib/db/bot-types"
import type { ResolvedBotDefinition } from "@/lib/bot/installed-bot"
import type { BotLifecycleContextV1 } from "@/types/bot/run"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { __resetBotsForTesting, registerBot } from "@/lib/plugin/registries/bot-registry"
import { projectBotInstallationSnapshot } from "@/lib/bot/installation-snapshot"
import { loggers } from "@/lib/plugin/core/logger"

import {
  BOT_LIFECYCLE_HOOK_TIMEOUT_MS,
  BotLifecycleHookError,
  runBotLifecycleHook,
} from "./lifecycle-hooks"

jest.mock("@/lib/plugin/core/logger", () => ({
  loggers: { manager: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } },
}))

const mockError = loggers.manager.error as jest.Mock
const mockInfo = loggers.manager.info as jest.Mock

function definition(overrides: Partial<PluginBotDef> = {}): PluginBotDef {
  return {
    id: "digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [{ id: "run", kind: "manual" }],
    ...overrides,
  } as PluginBotDef
}

function resolvedDefinition(overrides: Partial<ResolvedBotDefinition> = {}): ResolvedBotDefinition {
  return {
    id: "acme:digest",
    name: "Digest",
    version: "1.0.0",
    executor: "handler",
    triggers: [{ id: "run", kind: "manual" }],
    source: "plugin",
    ...overrides,
  }
}

function installation(overrides: Partial<BotInstallationRow> = {}): BotInstallationRow {
  return {
    id: "boti_1",
    definitionId: "acme:digest",
    definitionSource: "plugin",
    pinnedVersion: "1.0.0",
    scope: { kind: "account" },
    status: "enabled",
    config: { channel: "#alerts" },
    credentialBindings: {},
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

beforeEach(async () => {
  __resetBotsForTesting()
  await __resetDbForTesting()
  mockError.mockClear()
  mockInfo.mockClear()
})

describe("runBotLifecycleHook", () => {
  it("is a no-op for a local definition, which has no module", async () => {
    await expect(
      runBotLifecycleHook({
        installation: installation({ definitionSource: "local" }),
        definition: resolvedDefinition({ source: "local" }),
        phase: "onInstall",
      })
    ).resolves.toBeUndefined()
    expect(mockInfo).not.toHaveBeenCalled()
  })

  it("is a no-op when the plugin registry has no such Bot", async () => {
    await expect(
      runBotLifecycleHook({
        installation: installation(),
        definition: resolvedDefinition(),
        phase: "onInstall",
      })
    ).resolves.toBeUndefined()
  })

  it("is a no-op when the phase is not among the declared hooks", async () => {
    const onInstall = jest.fn()
    registerBot(
      "digest",
      { id: "acme:digest", definition: definition(), lifecycle: { onInstall } },
      { pluginId: "acme" }
    )
    await expect(
      runBotLifecycleHook({
        installation: installation(),
        definition: resolvedDefinition(),
        phase: "onConfigure",
      })
    ).resolves.toBeUndefined()
    expect(onInstall).not.toHaveBeenCalled()
  })

  it("hands the hook the same snapshot getInstallation projects", async () => {
    const row = installation()
    await getDb().botInstallations.add(row)
    let seen: BotLifecycleContextV1 | undefined
    const onInstall = jest.fn((ctx: BotLifecycleContextV1) => {
      seen = ctx
    })
    registerBot(
      "digest",
      { id: "acme:digest", definition: definition(), lifecycle: { onInstall } },
      { pluginId: "acme" }
    )
    const resolved = resolvedDefinition()

    await runBotLifecycleHook({
      installation: row,
      definition: resolved,
      phase: "onInstall",
    })

    expect(onInstall).toHaveBeenCalledTimes(1)
    expect(seen?.installation).toEqual(await projectBotInstallationSnapshot(row, resolved))
    expect(seen).not.toHaveProperty("previousConfig")
    expect(seen).not.toHaveProperty("trigger")
    expect(mockInfo).toHaveBeenCalledWith(
      "[bot-lifecycle]",
      expect.objectContaining({
        pluginId: "acme",
        botId: "acme:digest",
        phase: "onInstall",
        outcome: "ok",
      })
    )
  })

  it("passes previousConfig and trigger through to the context", async () => {
    let seen: BotLifecycleContextV1 | undefined
    registerBot(
      "digest",
      {
        id: "acme:digest",
        definition: definition(),
        lifecycle: {
          onConfigure: (ctx: BotLifecycleContextV1) => {
            seen = ctx
          },
        },
      },
      { pluginId: "acme" }
    )
    await runBotLifecycleHook({
      installation: installation(),
      definition: resolvedDefinition(),
      phase: "onConfigure",
      previousConfig: { channel: "#old" },
      trigger: { id: "run", armed: true },
    })
    expect(seen?.previousConfig).toEqual({ channel: "#old" })
    expect(seen?.trigger).toEqual({ id: "run", armed: true })
  })

  it.each(["onInstall", "onConfigure", "onArm"] as const)(
    "wraps a hook failure in BotLifecycleHookError for %s",
    async (phase) => {
      registerBot(
        "digest",
        {
          id: "acme:digest",
          definition: definition(),
          lifecycle: { [phase]: () => Promise.reject(new Error("veto")) },
        },
        { pluginId: "acme" }
      )
      const failure = runBotLifecycleHook({
        installation: installation(),
        definition: resolvedDefinition(),
        phase,
      })
      await expect(failure).rejects.toBeInstanceOf(BotLifecycleHookError)
      await expect(failure).rejects.toMatchObject({ phase, botId: "acme:digest" })
      expect(mockError).toHaveBeenCalledWith(expect.stringContaining(phase), expect.any(Error))
    }
  )

  it("swallows an onUninstall failure, logging it instead", async () => {
    registerBot(
      "digest",
      {
        id: "acme:digest",
        definition: definition(),
        lifecycle: { onUninstall: () => Promise.reject(new Error("cleanup exploded")) },
      },
      { pluginId: "acme" }
    )
    await expect(
      runBotLifecycleHook({
        installation: installation(),
        definition: resolvedDefinition(),
        phase: "onUninstall",
      })
    ).resolves.toBeUndefined()
    expect(mockError).toHaveBeenCalledWith(
      expect.stringContaining("onUninstall"),
      expect.any(Error)
    )
    expect(mockInfo).toHaveBeenCalledWith(
      "[bot-lifecycle]",
      expect.objectContaining({ phase: "onUninstall", outcome: "error" })
    )
  })

  it("times a stuck hook out and reports it like a failure", async () => {
    const timeoutSpy = jest
      .spyOn(global, "setTimeout")
      // Fire the timeout as soon as it is armed — the hook never settles, so
      // this is the same race the 30s wall clock would produce.
      .mockImplementation((cb: (...args: unknown[]) => void) => {
        cb()
        return 0 as never
      })
    registerBot(
      "digest",
      {
        id: "acme:digest",
        definition: definition(),
        lifecycle: { onArm: () => new Promise<void>(() => {}) },
      },
      { pluginId: "acme" }
    )
    try {
      await expect(
        runBotLifecycleHook({
          installation: installation(),
          definition: resolvedDefinition(),
          phase: "onArm",
          trigger: { id: "run", armed: false },
        })
      ).rejects.toMatchObject({
        name: "BotLifecycleHookError",
        phase: "onArm",
      })
      expect(mockError).toHaveBeenCalledWith(
        expect.stringContaining("onArm"),
        expect.objectContaining({ message: expect.stringContaining("exceeded") })
      )
    } finally {
      timeoutSpy.mockRestore()
    }
    expect(BOT_LIFECYCLE_HOOK_TIMEOUT_MS).toBe(30_000)
  })
})
