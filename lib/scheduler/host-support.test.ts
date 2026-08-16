import type { ScheduledTaskType } from "@/types/scheduler"
import {
  CARD_AUTHORED_TASK_TYPES,
  DEPRECATED_TASK_TYPES,
  TASK_TYPE_HOST_REQUIREMENTS,
  assertTaskTypeSupportedOnHost,
  describeLocalSchedulerHost,
  describeUnsupportedTaskType,
  getTaskTypeHostSupport,
  hostSatisfies,
  isCardAuthoredTaskType,
  isDeprecatedTaskType,
  unsupportedOnHost,
  type SchedulerHostDescriptor,
} from "./host-support"

const desktop: SchedulerHostDescriptor = {
  platform: "tauri",
  capabilities: ["webview", "shell", "sidecar", "keyring", "connector-runtime"],
}
const headless: SchedulerHostDescriptor = {
  platform: "headless",
  capabilities: ["shell", "sidecar", "keyring", "always-on", "connector-runtime", "headless"],
}
const web: SchedulerHostDescriptor = { platform: "web", capabilities: ["webview"] }
const mobile: SchedulerHostDescriptor = {
  platform: "mobile",
  capabilities: ["webview", "camera", "push-display"],
}

describe("host-support matrix", () => {
  it("marks sync and ai-generation as deprecated regardless of host", () => {
    for (const type of DEPRECATED_TASK_TYPES) {
      expect(isDeprecatedTaskType(type)).toBe(true)
      for (const host of [desktop, headless, web, mobile]) {
        const support = getTaskTypeHostSupport(type, host)
        expect(support).toMatchObject({ supported: false, reason: "deprecated-type" })
      }
    }
    expect(isDeprecatedTaskType("chat")).toBe(false)
    expect(isDeprecatedTaskType("nope")).toBe(false)
  })

  it("keeps card-authored types out of the generic form list but not out of the matrix", () => {
    expect(CARD_AUTHORED_TASK_TYPES).toContain("wiki-rebuild")
    expect(CARD_AUTHORED_TASK_TYPES).not.toContain("chat")
    expect(getTaskTypeHostSupport("wiki-lint", web).supported).toBe(true)
  })

  it.each<[ScheduledTaskType, boolean, boolean, boolean]>([
    // type, desktop, headless, web
    ["chat", true, true, false],
    ["agent", true, true, false],
    ["skill", true, true, false],
    ["goal", true, true, false],
    ["plan", true, true, false],
    ["agent-team", true, true, false],
    ["external-agent", true, true, false],
    ["script", true, true, false],
    ["background-command", true, true, false],
    ["monitor", true, true, false],
    ["backup", true, true, false],
    ["wiki-rebuild", true, true, false],
    ["workflow", true, true, true],
    ["test", true, true, true],
    ["plugin", true, true, true],
    ["custom", true, true, true],
    ["im-push", true, true, false],
  ])("%s → desktop=%s headless=%s web=%s", (type, onDesktop, onHeadless, onWeb) => {
    expect(getTaskTypeHostSupport(type, desktop).supported).toBe(onDesktop)
    expect(getTaskTypeHostSupport(type, headless).supported).toBe(onHeadless)
    expect(getTaskTypeHostSupport(type, web).supported).toBe(onWeb)
  })

  it("reports the first unmet requirement as the reason and every unmet one in missing", () => {
    const support = getTaskTypeHostSupport("chat", web)
    expect(support).toEqual({
      supported: false,
      reason: "missing-capability",
      missing: ["sidecar"],
      requires: ["sidecar"],
    })
    expect(getTaskTypeHostSupport("backup", mobile)).toMatchObject({
      reason: "missing-host-filesystem",
      missing: ["host-filesystem"],
    })
  })

  it("resolves the two host-shape requirements by platform", () => {
    expect(hostSatisfies("host-filesystem", desktop)).toBe(true)
    expect(hostSatisfies("host-filesystem", headless)).toBe(true)
    expect(hostSatisfies("host-filesystem", web)).toBe(false)
    expect(hostSatisfies("desktop-shell", desktop)).toBe(true)
    expect(hostSatisfies("desktop-shell", headless)).toBe(false)
    expect(hostSatisfies("shell", headless)).toBe(true)
    expect(hostSatisfies("shell", mobile)).toBe(false)
  })

  it("desktop-only requirement produces the desktop-only reason", () => {
    const original = TASK_TYPE_HOST_REQUIREMENTS
    const support = getTaskTypeHostSupport("test", headless)
    expect(support.supported).toBe(true)
    // Simulate a type that declares desktop-shell via the pure evaluator.
    const desktopOnly = {
      supported: false as const,
      reason: "desktop-only" as const,
      missing: ["desktop-shell" as const],
      requires: ["desktop-shell" as const],
    }
    expect(describeUnsupportedTaskType("test", desktopOnly, headless)).toMatch(/desktop app/)
    expect(original).toBe(TASK_TYPE_HOST_REQUIREMENTS)
  })

  it("describes every reason in plain language", () => {
    expect(
      describeUnsupportedTaskType("sync", getTaskTypeHostSupport("sync", desktop), desktop)
    ).toMatch(/deprecated/)
    expect(describeUnsupportedTaskType("chat", getTaskTypeHostSupport("chat", web), web)).toMatch(
      /sidecar capability/
    )
    expect(
      describeUnsupportedTaskType("backup", getTaskTypeHostSupport("backup", web), web)
    ).toMatch(/host filesystem/)
    expect(describeUnsupportedTaskType("test", getTaskTypeHostSupport("test", web), web)).toMatch(
      /supported on this host/
    )
  })

  it("builds a structured executor refusal", () => {
    const support = getTaskTypeHostSupport("script", web)
    const refusal = unsupportedOnHost("script", support, web)
    expect(refusal).toEqual({
      success: false,
      error: expect.stringMatching(/shell capability/),
      terminalReason: "unsupported-on-host",
      output: {
        hostSupport: { reason: "missing-capability", missing: ["shell"], platform: "web" },
      },
    })
    expect(assertTaskTypeSupportedOnHost("script", desktop)).toBeNull()
    expect(assertTaskTypeSupportedOnHost("script", web)).toMatchObject({ success: false })
  })

  it("describes the local host from the platform detector + capability baseline", () => {
    const local = describeLocalSchedulerHost()
    expect(["tauri", "web", "mobile", "headless"]).toContain(local.platform)
    expect(Array.isArray(local.capabilities)).toBe(true)
    // In jsdom/node tests the platform is "web": only the webview baseline.
    expect(local.capabilities).toContain("webview")
    expect(getTaskTypeHostSupport("test").supported).toBe(true)
  })

  describe("isCardAuthoredTaskType", () => {
    it("recognises card-authored types and nothing else", () => {
      expect(isCardAuthoredTaskType("twin")).toBe(true)
      expect(isCardAuthoredTaskType("connection:presence:refresh")).toBe(true)
      expect(isCardAuthoredTaskType("chat")).toBe(false)
      expect(isCardAuthoredTaskType("nope")).toBe(false)
    })
  })
})
