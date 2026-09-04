import type { AutomationPolicy } from "@cognia/agent-config-types"

import type { AutomationSettings } from "@/lib/automation/client"

const settingsGet = jest.fn()
const settingsSet = jest.fn()
const getFocus = jest.fn()
const getAutomationPolicy = jest.fn()
const saveAutomationPolicy = jest.fn()
let tauri = true

jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

jest.mock("@/lib/automation/client", () => ({
  desktop: {
    settingsGet: (...a: unknown[]) => settingsGet(...a),
    settingsSet: (...a: unknown[]) => settingsSet(...a),
    getFocus: (...a: unknown[]) => getFocus(...a),
  },
  defaultAutomationSettings: () => ({ whitelist: { processNames: [], windowTitlePatterns: [] } }),
}))

jest.mock("@/lib/automation/policy", () => ({
  getAutomationPolicy: (...a: unknown[]) => getAutomationPolicy(...a),
  saveAutomationPolicy: (...a: unknown[]) => saveAutomationPolicy(...a),
}))

import {
  captureFocusedTarget,
  defaultAutomationAccessRules,
  getAutomationAccessRules,
  isAdmitEmpty,
  isRestrictEmpty,
  saveAutomationAccessRules,
} from "./access-rules"

const restrict = (over: Partial<AutomationPolicy> = {}): AutomationPolicy => ({
  allowedProcessNames: [],
  allowedWindowTitlePatterns: [],
  allowedUrlPatterns: [],
  forbiddenScreenRegions: [],
  ...over,
})

const hostSettings = (processNames: string[] = []) =>
  ({
    enabled: true,
    whitelist: { processNames, windowTitlePatterns: [] },
  }) as unknown as AutomationSettings

beforeEach(() => {
  jest.clearAllMocks()
  tauri = true
  settingsSet.mockResolvedValue(undefined)
  saveAutomationPolicy.mockResolvedValue(undefined)
})

describe("emptiness", () => {
  it("reads an untouched document as empty on both stages", () => {
    const rules = defaultAutomationAccessRules()
    expect(isAdmitEmpty(rules.admit)).toBe(true)
    expect(isRestrictEmpty(rules.restrict)).toBe(true)
  })

  it("counts any populated list as non-empty", () => {
    expect(isAdmitEmpty({ processNames: [], windowTitlePatterns: ["*Excel*"] })).toBe(false)
    expect(isRestrictEmpty(restrict({ allowedUrlPatterns: ["^https://"] }))).toBe(false)
    expect(
      isRestrictEmpty(restrict({ forbiddenScreenRegions: [{ x: 0, y: 0, width: 1, height: 1 }] }))
    ).toBe(false)
  })
})

describe("getAutomationAccessRules", () => {
  it("reads both stores as one document", async () => {
    settingsGet.mockResolvedValue(hostSettings(["notepad.exe"]))
    getAutomationPolicy.mockResolvedValue(restrict({ allowedUrlPatterns: ["^https://intranet/"] }))

    const rules = await getAutomationAccessRules()

    expect(rules.admit.processNames).toEqual(["notepad.exe"])
    expect(rules.restrict.allowedUrlPatterns).toEqual(["^https://intranet/"])
  })

  it("answers with defaults where neither store is reachable", async () => {
    tauri = false
    await expect(getAutomationAccessRules()).resolves.toEqual(defaultAutomationAccessRules())
    expect(settingsGet).not.toHaveBeenCalled()
    expect(getAutomationPolicy).not.toHaveBeenCalled()
  })
})

describe("saveAutomationAccessRules", () => {
  it("writes both stages", async () => {
    settingsGet.mockResolvedValue(hostSettings([]))
    const next = {
      admit: { processNames: ["code.exe"], windowTitlePatterns: [] },
      restrict: restrict({ allowedProcessNames: ["code.exe"] }),
    }

    await saveAutomationAccessRules(next)

    expect(settingsSet).toHaveBeenCalledWith(expect.objectContaining({ whitelist: next.admit }))
    expect(saveAutomationPolicy).toHaveBeenCalledWith(next.restrict)
  })

  /**
   * The two stages live in different stores, so a half-applied edit is
   * reachable. Leaving the admit rules written while the restrict write failed
   * would show the user a document Rust does not hold.
   */
  it("puts the previous admit rules back when the restrict write fails", async () => {
    settingsGet.mockResolvedValue(hostSettings(["old.exe"]))
    saveAutomationPolicy.mockRejectedValue(new Error("policy rejected"))

    await expect(
      saveAutomationAccessRules({
        admit: { processNames: ["new.exe"], windowTitlePatterns: [] },
        restrict: restrict({ allowedProcessNames: ["new.exe"] }),
      })
    ).rejects.toThrow("policy rejected")

    expect(settingsSet).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ whitelist: { processNames: ["new.exe"], windowTitlePatterns: [] } })
    )
    expect(settingsSet).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ whitelist: { processNames: ["old.exe"], windowTitlePatterns: [] } })
    )
  })

  it("reports the original failure even when the rollback also fails", async () => {
    settingsGet.mockResolvedValue(hostSettings(["old.exe"]))
    saveAutomationPolicy.mockRejectedValue(new Error("policy rejected"))
    settingsSet.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("rollback failed"))

    await expect(
      saveAutomationAccessRules({
        admit: { processNames: ["new.exe"], windowTitlePatterns: [] },
        restrict: restrict(),
      })
    ).rejects.toThrow("policy rejected")
  })

  it("writes nothing where neither store is reachable", async () => {
    tauri = false
    await saveAutomationAccessRules(defaultAutomationAccessRules())
    expect(settingsSet).not.toHaveBeenCalled()
    expect(saveAutomationPolicy).not.toHaveBeenCalled()
  })
})

describe("captureFocusedTarget", () => {
  it("carries the focused window through", async () => {
    getFocus.mockResolvedValue({ processName: "notepad.exe", windowTitle: "Untitled - Notepad" })
    await expect(captureFocusedTarget()).resolves.toEqual({
      processName: "notepad.exe",
      windowTitle: "Untitled - Notepad",
    })
  })

  it("treats a blank name or title as absent", async () => {
    getFocus.mockResolvedValue({ processName: "   ", windowTitle: "" })
    await expect(captureFocusedTarget()).resolves.toEqual({
      processName: null,
      windowTitle: null,
    })
  })
})
