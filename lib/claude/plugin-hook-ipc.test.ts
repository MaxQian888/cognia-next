/** @jest-environment node */

jest.mock("@/lib/plugin/registries/hook-registry", () => ({
  getPluginHookHandler: jest.fn(),
  listHookContributors: jest.fn(() => []),
}))

import { getPluginHookHandler, listHookContributors } from "@/lib/plugin/registries/hook-registry"
import {
  handlePluginHookExec,
  BLOCKING_HOOK_EVENTS,
  HOOK_INTERCEPT_PERMISSION,
  PLUGIN_HOOK_BROADCAST,
} from "./plugin-hook-ipc"

const resolveMock = getPluginHookHandler as jest.Mock
const contributorsMock = listHookContributors as jest.Mock

const req = (over: Partial<Parameters<typeof handlePluginHookExec>[0]> = {}) => ({
  sessionId: "s1",
  execId: "e1",
  pluginId: "p1",
  hookId: "onPostToolUse",
  payload: { hook_event_name: "PostToolUse" },
  ...over,
})

beforeEach(() => {
  resolveMock.mockReset()
  contributorsMock.mockReset().mockReturnValue([])
})

describe("handlePluginHookExec", () => {
  it("runs a live handler and returns its result", async () => {
    const fn = jest.fn(async () => ({ additionalContext: "hi" }))
    resolveMock.mockReturnValue(fn)
    await expect(handlePluginHookExec(req())).resolves.toEqual({
      result: { additionalContext: "hi" },
    })
    expect(fn).toHaveBeenCalledWith({ hook_event_name: "PostToolUse" })
  })

  it("reports 'no live handler' for absent / disabled / missing-hook alike", async () => {
    // The registry collapses all three into `undefined`; the sidecar turns this
    // into a non-blocking warning, so a stale settings.json entry fails open.
    resolveMock.mockReturnValue(undefined)
    const out = await handlePluginHookExec(req())
    expect(out.error).toMatch(/no live handler/)
    expect(out.result).toBeUndefined()
  })

  it("never throws when the plugin handler does", async () => {
    resolveMock.mockReturnValue(() => {
      throw new Error("plugin exploded")
    })
    await expect(handlePluginHookExec(req())).resolves.toEqual({ error: "plugin exploded" })
  })

  it("normalises an undefined return to null rather than dropping the response", async () => {
    // A dropped response would leave the sidecar waiting out its whole timeout.
    resolveMock.mockReturnValue(() => undefined)
    await expect(handlePluginHookExec(req())).resolves.toEqual({ result: null })
  })
})

describe("the intercept permission gate", () => {
  it.each(BLOCKING_HOOK_EVENTS)("refuses %s without the permission", async (event) => {
    resolveMock.mockReturnValue(jest.fn())
    const out = await handlePluginHookExec(
      req({ hookId: "onPreToolUse", payload: { hook_event_name: event } }),
      { hasPermission: () => false }
    )
    // Refused rather than silently downgraded to observational: the user
    // configured a gate and deserves to know it is not one.
    expect(out.error).toContain(HOOK_INTERCEPT_PERMISSION)
    expect(out.result).toBeUndefined()
  })

  it.each(BLOCKING_HOOK_EVENTS)("allows %s once the permission is declared", async (event) => {
    const fn = jest.fn(async () => ({ block: "denied" }))
    resolveMock.mockReturnValue(fn)
    const out = await handlePluginHookExec(
      req({ hookId: "onPreToolUse", payload: { hook_event_name: event } }),
      { hasPermission: () => true }
    )
    expect(out.result).toEqual({ block: "denied" })
  })

  it("does not require the permission for an observational event", async () => {
    // Two independent gates: writing the handler into settings.json is the
    // user's, and the capability is the plugin's — but only where a decision
    // can actually deny a turn.
    const fn = jest.fn(async () => ({}))
    resolveMock.mockReturnValue(fn)
    const hasPermission = jest.fn(() => false)
    const out = await handlePluginHookExec(req({ payload: { hook_event_name: "SessionStart" } }), {
      hasPermission,
    })
    expect(out.result).toEqual({})
    expect(hasPermission).not.toHaveBeenCalled()
  })

  it("treats a payload with no event name as non-blocking", async () => {
    resolveMock.mockReturnValue(jest.fn(async () => ({})))
    const hasPermission = jest.fn(() => false)
    await handlePluginHookExec(req({ payload: {} }), { hasPermission })
    expect(hasPermission).not.toHaveBeenCalled()
  })
})

describe("broadcast fan-out", () => {
  it("merges every contributor's result, later winning per key", async () => {
    contributorsMock.mockReturnValue(["a", "b"])
    resolveMock.mockImplementation((pluginId: string) =>
      pluginId === "a"
        ? async () => ({ skipCompaction: true, contextToInject: "from-a" })
        : async () => ({ contextToInject: "from-b" })
    )
    const out = await handlePluginHookExec(
      req({ pluginId: PLUGIN_HOOK_BROADCAST, hookId: "onPreCompact" })
    )
    expect(out.result).toEqual({ skipCompaction: true, contextToInject: "from-b" })
  })

  it("skips a throwing contributor instead of failing the fan-out", async () => {
    contributorsMock.mockReturnValue(["bad", "good"])
    resolveMock.mockImplementation((pluginId: string) =>
      pluginId === "bad"
        ? () => {
            throw new Error("nope")
          }
        : async () => ({ skipCompaction: true })
    )
    const out = await handlePluginHookExec(
      req({ pluginId: PLUGIN_HOOK_BROADCAST, hookId: "onPreCompact" })
    )
    expect(out.result).toEqual({ skipCompaction: true })
    expect(out.error).toBeUndefined()
  })

  it("returns null with no contributors", async () => {
    contributorsMock.mockReturnValue([])
    const out = await handlePluginHookExec(
      req({ pluginId: PLUGIN_HOOK_BROADCAST, hookId: "onPreCompact" })
    )
    expect(out.result).toBeNull()
  })

  it("does not apply the intercept gate to a host-owned broadcast", async () => {
    // The host chose to ask, and these hooks transform rather than gate.
    contributorsMock.mockReturnValue(["a"])
    resolveMock.mockReturnValue(async () => ({ ok: true }))
    const hasPermission = jest.fn(() => false)
    const out = await handlePluginHookExec(
      req({
        pluginId: PLUGIN_HOOK_BROADCAST,
        hookId: "onPreToolUse",
        payload: { hook_event_name: "PreToolUse" },
      }),
      { hasPermission }
    )
    expect(out.result).toEqual({ ok: true })
    expect(hasPermission).not.toHaveBeenCalled()
  })
})
