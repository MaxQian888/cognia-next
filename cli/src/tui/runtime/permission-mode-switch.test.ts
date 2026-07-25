import {
  BYPASS_CONFIRM_BODY,
  BYPASS_CONFIRM_TITLE,
  BYPASS_DECLINE_MODE,
  bypassConfirmOverlay,
  permissionModeNotice,
  planPermissionModeSwitch,
  startupBypassConfirmOverlay,
} from "./permission-mode-switch"
import { PERMISSION_MODES } from "../../config/schema"
import { permissionModeMeta, requiresAcknowledgement } from "../state/permission-mode-meta"

describe("permissionModeNotice", () => {
  it("carries the mode plus its one-line consequence for every mode", () => {
    for (const mode of PERMISSION_MODES) {
      expect(permissionModeNotice(mode)).toBe(
        `Permission mode: ${mode} — ${permissionModeMeta(mode).runsWithoutAsking}`
      )
    }
  })
})

describe("planPermissionModeSwitch", () => {
  it("applies a safe mode straight away", () => {
    const plan = planPermissionModeSwitch({ next: "acceptEdits", acknowledged: false })
    expect(plan).toEqual({
      kind: "apply",
      mode: "acceptEdits",
      notice: permissionModeNotice("acceptEdits"),
    })
  })

  it("asks before entering a danger-tier mode", () => {
    const plan = planPermissionModeSwitch({ next: "bypassPermissions", acknowledged: false })
    expect(plan.kind).toBe("confirm")
    expect(plan.mode).toBe("bypassPermissions")
    if (plan.kind !== "confirm") throw new Error("expected a confirm plan")
    expect(plan.overlay).toMatchObject({
      kind: "confirm",
      title: BYPASS_CONFIRM_TITLE,
      // The confirm re-enters the SAME switch with the acknowledgement given —
      // that round-trip is what keeps one implementation for every entry point.
      onConfirmCommand: "mode bypassPermissions --force",
    })
  })

  it("stops asking once the session has acknowledged", () => {
    const plan = planPermissionModeSwitch({ next: "bypassPermissions", acknowledged: true })
    expect(plan.kind).toBe("apply")
  })

  it("treats --force as the acknowledgement (the confirm's own dispatch)", () => {
    const plan = planPermissionModeSwitch({
      next: "bypassPermissions",
      acknowledged: false,
      force: true,
    })
    expect(plan.kind).toBe("apply")
  })

  it("gates exactly the modes the risk model calls dangerous", () => {
    for (const mode of PERMISSION_MODES) {
      const plan = planPermissionModeSwitch({ next: mode, acknowledged: false })
      expect(plan.kind).toBe(requiresAcknowledgement(mode) ? "confirm" : "apply")
    }
  })
})

describe("bypassConfirmOverlay", () => {
  it("says the mode reaches the external agent too, not just the local UI", () => {
    // The load-bearing half of the warning: a user accepting here is also
    // accepting it for whichever agent is hosting the session.
    expect(BYPASS_CONFIRM_BODY).toMatch(/external agent/i)
    expect(BYPASS_CONFIRM_BODY).toMatch(/sandbox/i)
  })

  it("has no cancel command by default — a mid-session switch applied nothing", () => {
    expect(bypassConfirmOverlay("bypassPermissions")).not.toHaveProperty("onCancelCommand")
  })

  it("de-escalates on decline at startup, where the mode is already armed", () => {
    expect(startupBypassConfirmOverlay("bypassPermissions")).toMatchObject({
      onConfirmCommand: "mode bypassPermissions --force",
      onCancelCommand: `mode ${BYPASS_DECLINE_MODE}`,
    })
    expect(requiresAcknowledgement(BYPASS_DECLINE_MODE)).toBe(false)
  })
})
