/**
 * Tests for `lib/automation/policy.ts` — ADR-0028 / T5 client-side wiring.
 *
 * The Tauri transport and the Dexie settings store are both mocked so the
 * tests exercise the policy-flow logic in isolation. End-to-end coverage
 * for the dispatcher integration lives in the Rust side.
 */

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
  isTauri: jest.fn(() => true),
}))

jest.mock("@/lib/db/settings", () => ({
  getSettings: jest.fn(),
  saveSettings: jest.fn(),
}))

import { transport, isTauri } from "@/lib/tauri"
import { getSettings, saveSettings } from "@/lib/db/settings"

import {
  getAutomationPolicy,
  setAutomationPolicy,
  saveAutomationPolicy,
  hydrateAutomationPolicy,
} from "./policy"
import { DEFAULT_AUTOMATION_POLICY } from "@/lib/claude/types"
import type { AutomationPolicy, AppSettings } from "@/lib/claude/types"

const mockCall = transport.call as unknown as jest.Mock
const mockIsTauri = isTauri as unknown as jest.Mock
const mockGetSettings = getSettings as unknown as jest.Mock
const mockSaveSettings = saveSettings as unknown as jest.Mock

const policy: AutomationPolicy = {
  allowedProcessNames: ["Chrome"],
  allowedWindowTitlePatterns: ["^Inbox"],
  allowedUrlPatterns: ["^https://"],
  forbiddenScreenRegions: [{ x: 0, y: 0, width: 100, height: 100 }],
}

afterEach(() => {
  mockCall.mockReset()
  mockIsTauri.mockReset()
  mockIsTauri.mockReturnValue(true)
  mockGetSettings.mockReset()
  mockSaveSettings.mockReset()
})

describe("getAutomationPolicy", () => {
  it("invokes automation_policy_get when running under Tauri", async () => {
    mockCall.mockResolvedValueOnce(policy)
    const got = await getAutomationPolicy()
    expect(mockCall).toHaveBeenCalledWith("automation_policy_get", {})
    expect(got).toEqual(policy)
  })

  it("returns the empty default outside Tauri without calling IPC", async () => {
    mockIsTauri.mockReturnValue(false)
    const got = await getAutomationPolicy()
    expect(mockCall).not.toHaveBeenCalled()
    expect(got).toEqual(DEFAULT_AUTOMATION_POLICY)
  })
})

describe("setAutomationPolicy", () => {
  it("invokes automation_policy_set with the policy payload", async () => {
    mockCall.mockResolvedValueOnce(undefined)
    await setAutomationPolicy(policy)
    expect(mockCall).toHaveBeenCalledWith("automation_policy_set", { policy })
  })

  it("is a no-op outside Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    await setAutomationPolicy(policy)
    expect(mockCall).not.toHaveBeenCalled()
  })
})

describe("saveAutomationPolicy", () => {
  it("persists to settings AND pushes to Rust state", async () => {
    mockGetSettings.mockResolvedValueOnce({ automationPolicy: undefined } as Partial<AppSettings>)
    mockSaveSettings.mockResolvedValueOnce({})
    mockCall.mockResolvedValueOnce(undefined)
    await saveAutomationPolicy(policy)
    expect(mockSaveSettings).toHaveBeenCalledWith({ automationPolicy: policy })
    expect(mockCall).toHaveBeenCalledWith("automation_policy_set", { policy })
  })

  it("rolls back the settings write when the IPC fails", async () => {
    const previous = DEFAULT_AUTOMATION_POLICY
    mockGetSettings.mockResolvedValueOnce({ automationPolicy: previous } as Partial<AppSettings>)
    mockSaveSettings.mockResolvedValue({})
    mockCall.mockRejectedValueOnce(new Error("ipc boom"))
    await expect(saveAutomationPolicy(policy)).rejects.toThrow("ipc boom")
    expect(mockSaveSettings).toHaveBeenNthCalledWith(1, { automationPolicy: policy })
    expect(mockSaveSettings).toHaveBeenNthCalledWith(2, { automationPolicy: previous })
  })
})

describe("hydrateAutomationPolicy", () => {
  it("pushes the stored policy on boot", async () => {
    mockGetSettings.mockResolvedValueOnce({
      automationPolicy: policy,
    } as Partial<AppSettings>)
    mockCall.mockResolvedValueOnce(undefined)
    await hydrateAutomationPolicy()
    expect(mockCall).toHaveBeenCalledWith("automation_policy_set", { policy })
  })

  it("uses the empty default when settings have no policy", async () => {
    mockGetSettings.mockResolvedValueOnce({} as Partial<AppSettings>)
    mockCall.mockResolvedValueOnce(undefined)
    await hydrateAutomationPolicy()
    expect(mockCall).toHaveBeenCalledWith("automation_policy_set", {
      policy: DEFAULT_AUTOMATION_POLICY,
    })
  })

  it("is a no-op outside Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    await hydrateAutomationPolicy()
    expect(mockGetSettings).not.toHaveBeenCalled()
    expect(mockCall).not.toHaveBeenCalled()
  })
})
