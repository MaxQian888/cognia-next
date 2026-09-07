/** @jest-environment jsdom */

import { act, renderHook } from "@testing-library/react"

import type { BotCatalogEntry } from "@/lib/bot/console/catalog"
import type { BotCredentialCandidate } from "@/lib/bot/console/credential-candidates"

const installBotFromCatalog = jest.fn(async (_input: unknown) => ({ id: "boti_new" }))
const updateBotConfig = jest.fn(async (_id: string, _config: Record<string, unknown>) => ({}))
const bindBotCredential = jest.fn(async (_id: string, _slot: string, _binding: unknown) => ({}))
const setBotInstallationEnabled = jest.fn(async (_id: string, _enabled: boolean) => ({
  status: "enabled",
}))
const uninstallBotInstallation = jest.fn(async (_id: string) => undefined)

let availability = { state: "available", reason: "local-host" }

// Declared INSIDE the factory: `jest.mock` is hoisted above every `const` in
// this file, so referring to one declared out here is a temporal-dead-zone
// error at import time rather than a failing assertion.
jest.mock("@/lib/bot/control-writes", () => {
  class BotLifecycleUnavailableError extends Error {
    readonly availability = { state: "unsupported", reason: "requires-companion" }
  }
  class BotNotInstallableError extends Error {}
  class BotDefinitionMissingError extends Error {}
  class BotControlTargetMissingError extends Error {
    readonly what = "installation"
  }
  return {
    BotLifecycleUnavailableError,
    BotNotInstallableError,
    BotDefinitionMissingError,
    BotControlTargetMissingError,
    installBotFromCatalog: (input: unknown) => installBotFromCatalog(input),
    updateBotConfig: (id: string, config: Record<string, unknown>) => updateBotConfig(id, config),
    bindBotCredential: (id: string, slot: string, binding: unknown) =>
      bindBotCredential(id, slot, binding),
    setBotInstallationEnabled: (id: string, enabled: boolean) =>
      setBotInstallationEnabled(id, enabled),
    uninstallBotInstallation: (id: string) => uninstallBotInstallation(id),
    resolveBotLifecycleWriteAvailability: () => availability,
  }
})

let notifyRoute: (() => void) | undefined
jest.mock("@/lib/runtime/runtime-snapshot-store", () => ({
  subscribeRuntimeSnapshot: (listener: () => void) => {
    notifyRoute = listener
    return () => {
      notifyRoute = undefined
    }
  },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  subscribeActiveRemoteTransport: () => () => {},
}))
jest.mock("@/stores/remote-host/remote-host-store", () => ({
  useRemoteHostStore: { subscribe: () => () => {} },
}))

const success = jest.fn()
const error = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => success(...a), error: (...a: unknown[]) => error(...a) },
}))

import { useBotLifecycleActions, useBotLifecycleReadiness } from "./use-bot-lifecycle-actions"

const {
  BotLifecycleUnavailableError: FakeUnavailable,
  BotNotInstallableError: FakeNotInstallable,
  BotDefinitionMissingError: FakeDefinitionMissing,
} = jest.requireMock("@/lib/bot/control-writes") as {
  BotLifecycleUnavailableError: new (message: string) => Error
  BotNotInstallableError: new (message: string) => Error
  BotDefinitionMissingError: new (message: string) => Error
}

function entry(): BotCatalogEntry {
  return {
    definitionId: "acme:digest",
    source: "plugin",
    name: "Daily digest",
    version: "1.0.0",
    executor: "workflow",
    triggers: [],
    slots: [],
    requiredSlots: [],
    installedCount: 0,
    unresolvedHandler: false,
  }
}

const CANDIDATE: BotCredentialCandidate = {
  value: "iacc_1",
  kind: "integration-account",
  label: "Octocat",
  disabled: false,
}

beforeEach(() => {
  installBotFromCatalog.mockClear().mockResolvedValue({ id: "boti_new" })
  updateBotConfig.mockClear().mockResolvedValue({})
  bindBotCredential.mockClear().mockResolvedValue({})
  setBotInstallationEnabled.mockClear().mockResolvedValue({ status: "enabled" })
  uninstallBotInstallation.mockClear().mockResolvedValue(undefined)
  success.mockClear()
  error.mockClear()
  availability = { state: "available", reason: "local-host" }
})

describe("useBotLifecycleReadiness", () => {
  it("reports whether the lifecycle may be driven from here", () => {
    const { result } = renderHook(() => useBotLifecycleReadiness())
    expect(result.current).toEqual({ availability, can: true })
  })

  it("re-reads when the runtime changes under it", () => {
    // A control that asked once at mount keeps offering itself after the
    // desktop it was reading pairs with a remote host.
    const { result } = renderHook(() => useBotLifecycleReadiness())
    expect(result.current.can).toBe(true)

    availability = { state: "unsupported", reason: "operation-unavailable" }
    act(() => notifyRoute?.())
    expect(result.current.can).toBe(false)
  })
})

describe("useBotLifecycleActions", () => {
  it("returns the new installation id so the console can select it", async () => {
    const { result } = renderHook(() => useBotLifecycleActions())
    let id: string | undefined
    await act(async () => {
      id = await result.current.install({ entry: entry(), scope: { kind: "account" } })
    })
    expect(id).toBe("boti_new")
    expect(success).toHaveBeenCalledWith("Daily digest installed")
  })

  it("answers undefined rather than a fake id when the install refuses", async () => {
    installBotFromCatalog.mockRejectedValue(new FakeNotInstallable("no handler"))
    const { result } = renderHook(() => useBotLifecycleActions())
    let id: string | undefined = "unset"
    await act(async () => {
      id = await result.current.install({ entry: entry(), scope: { kind: "account" } })
    })
    expect(id).toBeUndefined()
    expect(error).toHaveBeenCalledWith("That Bot cannot be installed while its handler is missing.")
  })

  it("reports the status the write RESULTED in, not the one that was asked for", async () => {
    // Asking to enable a Bot with an unbound slot answers `needs_setup`, and
    // saying "enabled" there would contradict the row the user is looking at.
    setBotInstallationEnabled.mockResolvedValue({ status: "needs_setup" })
    const { result } = renderHook(() => useBotLifecycleActions())
    await act(() => result.current.setEnabled("boti_1", true))
    expect(success).toHaveBeenCalledWith("Still needs a credential, so it stays off")
  })

  it("turns a picked candidate into exactly one id, and a clear into null", async () => {
    const { result } = renderHook(() => useBotLifecycleActions())
    await act(() => result.current.bindCredential("boti_1", "gh", CANDIDATE))
    expect(bindBotCredential).toHaveBeenCalledWith("boti_1", "gh", {
      integrationAccountId: "iacc_1",
    })

    await act(() => result.current.bindCredential("boti_1", "gh", null))
    expect(bindBotCredential).toHaveBeenLastCalledWith("boti_1", "gh", null)
  })

  it("explains an unavailable write with its reason, not a generic failure", async () => {
    updateBotConfig.mockRejectedValue(new FakeUnavailable("nope"))
    const { result } = renderHook(() => useBotLifecycleActions())
    await act(() => result.current.saveConfig("boti_1", {}))
    expect(error).toHaveBeenCalledWith("That change cannot be made from here", {
      description: "This browser cannot run Bots. Pair a Host or use the desktop app.",
    })
  })

  it("names a missing definition, which needs a different remedy from a missing row", async () => {
    bindBotCredential.mockRejectedValue(new FakeDefinitionMissing("gone"))
    const { result } = renderHook(() => useBotLifecycleActions())
    await act(() => result.current.bindCredential("boti_1", "gh", CANDIDATE))
    expect(error).toHaveBeenCalledWith(
      "That Bot's definition is gone. Reinstall the plugin that owned it, or uninstall this Bot."
    )
  })

  it("keeps the underlying message for anything unexpected", async () => {
    uninstallBotInstallation.mockRejectedValue(new Error("QuotaExceededError"))
    const { result } = renderHook(() => useBotLifecycleActions())
    let removed: boolean | undefined
    await act(async () => {
      removed = await result.current.uninstall("boti_1")
    })
    expect(removed).toBe(false)
    expect(error).toHaveBeenCalledWith("The change could not be saved", {
      description: "QuotaExceededError",
    })
  })

  it("clears the pending key even when the write throws", async () => {
    updateBotConfig.mockRejectedValue(new Error("boom"))
    const { result } = renderHook(() => useBotLifecycleActions())
    await act(() => result.current.saveConfig("boti_1", {}))
    expect(result.current.pending.has("config:boti_1")).toBe(false)
  })
})
