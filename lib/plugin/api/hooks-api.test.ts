/** @jest-environment node */

jest.mock("@/lib/plugin/registries/hook-registry", () => ({
  getPluginHookContribution: jest.fn(),
  isPluginHooksEnabled: jest.fn(() => true),
  listHookContributors: jest.fn(() => []),
}))

import {
  getPluginHookContribution,
  isPluginHooksEnabled,
  listHookContributors,
} from "@/lib/plugin/registries/hook-registry"
import { createHooksAPI } from "./hooks-api"

const contributionMock = getPluginHookContribution as jest.Mock
const enabledMock = isPluginHooksEnabled as jest.Mock
const contributorsMock = listHookContributors as jest.Mock

const api = () => createHooksAPI("p1")

beforeEach(() => {
  contributionMock.mockReset().mockReturnValue(undefined)
  enabledMock.mockReset().mockReturnValue(true)
  contributorsMock.mockReset().mockReturnValue([])
})

describe("listOwn", () => {
  it("names only the function-valued hooks", () => {
    contributionMock.mockReturnValue({
      hooks: { onPreToolUse: () => {}, onStop: undefined, notAHook: "text" },
      priority: 0,
    })
    expect(api().listOwn()).toEqual(["onPreToolUse"])
  })

  it("is empty before activation", () => {
    expect(api().listOwn()).toEqual([])
  })
})

describe("isActive", () => {
  it("is true only when the plugin has registered AND is enabled", () => {
    // The diagnosis a plugin author could not previously make: "my hook never
    // fires" has two distinct causes and this separates them.
    expect(api().isActive()).toBe(false)

    contributionMock.mockReturnValue({ hooks: { onStop: () => {} }, priority: 0 })
    expect(api().isActive()).toBe(true)

    enabledMock.mockReturnValue(false)
    expect(api().isActive()).toBe(false)
  })
})

describe("binding", () => {
  it("produces the exact settings.json handler entry", () => {
    contributionMock.mockReturnValue({ hooks: { onPreToolUse: () => {} }, priority: 0 })
    expect(api().binding("onPreToolUse")).toEqual({
      type: "plugin",
      pluginId: "p1",
      hookId: "onPreToolUse",
    })
  })

  it("returns null for a hook the plugin does not contribute", () => {
    // A typo surfaces here instead of failing open at run time, which is the
    // whole reason this method exists.
    contributionMock.mockReturnValue({ hooks: { onPreToolUse: () => {} }, priority: 0 })
    expect(api().binding("onPreToolUseTypo")).toBeNull()
    contributionMock.mockReturnValue(undefined)
    expect(api().binding("onPreToolUse")).toBeNull()
  })
})

describe("permission guidance", () => {
  it("flags exactly the events where a decision can deny the turn", () => {
    const a = api()
    expect(a.requiresInterceptPermission("PreToolUse")).toBe(true)
    expect(a.requiresInterceptPermission("UserPromptSubmit")).toBe(true)
    expect(a.requiresInterceptPermission("PostToolUse")).toBe(false)
    expect(a.requiresInterceptPermission("SessionStart")).toBe(false)
  })

  it("exposes the permission name so authors need not hard-code it", () => {
    expect(api().interceptPermission).toBe("hooks:chat-intercept")
  })
})

describe("hasListener", () => {
  it("reports on the whole runtime, not just this plugin", () => {
    contributorsMock.mockReturnValue(["other-plugin"])
    expect(api().hasListener("onMessageSend")).toBe(true)
    contributorsMock.mockReturnValue([])
    expect(api().hasListener("onMessageSend")).toBe(false)
  })
})
