import { readFileSync } from "node:fs"
import { join } from "node:path"

import { effectiveCapabilities } from "./effective-capabilities"
import {
  CAPABILITY_UNAVAILABLE_CAUSES,
  capabilityAvailability,
  isActionableCause,
} from "./capability-availability"

describe("capabilityAvailability", () => {
  it("reports an available capability without a cause", () => {
    const snapshot = effectiveCapabilities({ platform: "telegram" })
    expect(capabilityAvailability(snapshot, "send.reply")).toEqual({
      available: true,
      capability: "send.reply",
    })
  })

  /**
   * The case every hiding site actually hit. `suppressionFor` answers
   * `undefined` here, exactly as it does for a working capability, so a
   * read-out built on suppressions alone would have had nothing to say on 4 of
   * 11 platforms for `send.reply` alone.
   */
  it("separates 'the platform never offered it' from a suppression", () => {
    const snapshot = effectiveCapabilities({ platform: "wecom" })
    expect(snapshot.suppressed).toEqual([])
    expect(capabilityAvailability(snapshot, "send.reply")).toEqual({
      available: false,
      capability: "send.reply",
      cause: "not_declared",
      actionable: false,
    })
  })

  it("carries a suppression's own reason and detail through", () => {
    const snapshot = effectiveCapabilities({
      platform: "slack",
      settings: { connectedScopes: { scopes: ["chat:write"] } },
    })
    expect(capabilityAvailability(snapshot, "history.fetch")).toEqual({
      available: false,
      capability: "history.fetch",
      cause: "missing_oauth_scope",
      detail: "channels:history | groups:history | im:history | mpim:history",
      actionable: true,
    })
  })

  it("marks a transport suppression actionable — the operator can change it", () => {
    const snapshot = effectiveCapabilities({ platform: "discord", transportMode: "webhook" })
    const result = capabilityAvailability(snapshot, "presence.status")
    expect(result).toMatchObject({ cause: "transport_unsupported", actionable: true })
  })

  /**
   * A scene limit is a property of where the conversation lives, so there is
   * no next step. Dressing it up as one would send an operator to re-check
   * settings that are already correct.
   */
  it("marks a scene limit unactionable", () => {
    const snapshot = effectiveCapabilities({ platform: "qq-official", scopeKind: "private" })
    const result = capabilityAvailability(snapshot, "send.reaction")
    expect(result).toMatchObject({ cause: "scene_unsupported", actionable: false })
  })

  /**
   * The read-out must never contradict the gate the runtime, the tool manifest
   * and delivery all read. Asserting equality with the snapshot's own list
   * pins that they cannot drift apart.
   */
  it("agrees with the snapshot for every declared capability", () => {
    const snapshot = effectiveCapabilities({
      platform: "slack",
      settings: { connectedScopes: { scopes: ["chat:write"] } },
    })
    for (const capability of snapshot.declared) {
      expect(capabilityAvailability(snapshot, capability).available).toBe(
        snapshot.capabilities.includes(capability)
      )
    }
  })
})

describe("CAPABILITY_UNAVAILABLE_CAUSES", () => {
  it("is the five suppression reasons plus the undeclared case", () => {
    expect(CAPABILITY_UNAVAILABLE_CAUSES).toEqual([
      "transport_unsupported",
      "missing_oauth_scope",
      "upstream_impl_unsupported",
      "instance_setting_off",
      "scene_unsupported",
      "not_declared",
    ])
  })

  it("splits cleanly into causes with and without a remedy", () => {
    const actionable = CAPABILITY_UNAVAILABLE_CAUSES.filter(isActionableCause)
    expect(actionable).toEqual([
      "transport_unsupported",
      "missing_oauth_scope",
      "upstream_impl_unsupported",
      "instance_setting_off",
    ])
  })
})

/**
 * `t(`reason.${cause}`)` is a template-literal key, and `pnpm lint:i18n` skips
 * every one of those — so a cause added without its message would render the
 * raw key on the three surfaces this vocabulary exists for. The union is
 * imported rather than re-listed so a new member fails here instead of
 * quietly falling outside the check.
 */
describe.each(["en", "zh-CN"])("connectors.capability catalogue — %s", (locale) => {
  const messages = JSON.parse(
    readFileSync(join(process.cwd(), "i18n/messages", locale, "connectors.json"), "utf8")
  ).capability as { reason: Record<string, string>; nextStep: Record<string, string> }

  it("has a reason for every cause", () => {
    expect(Object.keys(messages.reason).sort()).toEqual([...CAPABILITY_UNAVAILABLE_CAUSES].sort())
  })

  it("has a next step for exactly the actionable causes", () => {
    expect(Object.keys(messages.nextStep).sort()).toEqual(
      CAPABILITY_UNAVAILABLE_CAUSES.filter(isActionableCause).sort()
    )
  })

  /**
   * Every cause but `not_declared` carries machine-readable specifics, and a
   * message that dropped `{detail}` would turn "missing channels:history" into
   * an unactionable "missing something".
   */
  it("interpolates the detail wherever there is one", () => {
    for (const cause of CAPABILITY_UNAVAILABLE_CAUSES) {
      if (cause === "not_declared") continue
      expect(messages.reason[cause]).toContain("{detail}")
    }
    expect(messages.reason.not_declared).not.toContain("{detail}")
  })
})
