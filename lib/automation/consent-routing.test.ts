import type { ConsentRequestEvent } from "./client"
import {
  __resetConsentRouting,
  claimConsentSurface,
  consentPromptOf,
  getConsentRoutingVersion,
  isConsentRoutedElsewhere,
  markConsentSettled,
  subscribeConsentRouting,
} from "./consent-routing"

const event: ConsentRequestEvent = {
  id: "c1",
  command: "capture_frontmost_window",
  surface: "chatCopilot",
  pluginId: null,
  processName: "WeChat",
  windowTitle: "Ann",
  timeoutMs: 90_000,
}

beforeEach(() => __resetConsentRouting())

describe("consent routing", () => {
  it("hides a claimed surface's prompts until every claim is released", () => {
    expect(isConsentRoutedElsewhere(event)).toBe(false)
    const first = claimConsentSurface("chatCopilot")
    const second = claimConsentSurface("chatCopilot")
    expect(isConsentRoutedElsewhere(event)).toBe(true)
    expect(isConsentRoutedElsewhere({ id: "c2", surface: "computerUse" })).toBe(false)
    first()
    first() // idempotent
    expect(isConsentRoutedElsewhere(event)).toBe(true)
    second()
    expect(isConsentRoutedElsewhere(event)).toBe(false)
  })

  it("drops a prompt answered elsewhere, whatever its surface", () => {
    markConsentSettled("c9")
    expect(isConsentRoutedElsewhere({ id: "c9", surface: "computerUse" })).toBe(true)
  })

  it("notifies subscribers and moves the snapshot on every change", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeConsentRouting(listener)
    const before = getConsentRoutingVersion()
    const release = claimConsentSurface("chatCopilot")
    markConsentSettled("c1")
    markConsentSettled("c1") // no-op
    release()
    expect(listener).toHaveBeenCalledTimes(3)
    expect(getConsentRoutingVersion()).toBe(before + 3)
    unsubscribe()
    claimConsentSurface("plugin")
    expect(listener).toHaveBeenCalledTimes(3)
  })

  it("keeps only the grant key fields of a prompt", () => {
    expect(consentPromptOf({ ...event, sessionKey: "s1" })).toEqual({
      command: "capture_frontmost_window",
      surface: "chatCopilot",
      pluginId: null,
      processName: "WeChat",
      windowTitle: "Ann",
      commandDetail: null,
      sessionKey: "s1",
    })
  })
})
