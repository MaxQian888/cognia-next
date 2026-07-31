import { createDiagnostic } from "@cognia/diagnostics"
import { NOTIFICATION_LEVELS, NOTIFICATION_SOURCES } from "@/types/notifications"

import {
  DIAGNOSTIC_SEVERITY_TO_LEVEL,
  DIAGNOSTIC_SOURCE_IDS,
  DIAGNOSTIC_SOURCE_TO_NOTIFICATION,
  toNotificationInput,
} from "./notification-mapping"

const opts = {
  resolveTitle: (code: string) => `title:${code}`,
  resolveActionLabel: (kind: string) => `label:${kind}`,
}

const diag = (code: Parameters<typeof createDiagnostic>[0], init = {}) =>
  createDiagnostic(code, { source: "chat", now: () => 0, id: "d1", ...init })

describe("source / level mapping", () => {
  it("maps every diagnostic source onto an existing notification source", () => {
    // No new NotificationSource members: the existing seven already cover us.
    expect(Object.keys(DIAGNOSTIC_SOURCE_TO_NOTIFICATION).sort()).toEqual(
      [...DIAGNOSTIC_SOURCE_IDS].sort()
    )
    for (const value of Object.values(DIAGNOSTIC_SOURCE_TO_NOTIFICATION)) {
      expect(NOTIFICATION_SOURCES).toContain(value)
    }
  })

  it("maps every severity onto an existing notification level", () => {
    for (const value of Object.values(DIAGNOSTIC_SEVERITY_TO_LEVEL)) {
      expect(NOTIFICATION_LEVELS).toContain(value)
    }
  })

  it("escalates fatal to critical so DND cannot swallow it", () => {
    expect(DIAGNOSTIC_SEVERITY_TO_LEVEL.fatal).toBe("critical")
  })
})

describe("toNotificationInput", () => {
  it("titles from the code and bodies from the raw text", () => {
    const input = toNotificationInput(diag("rateLimited", { message: "429" }), opts)
    expect(input.title).toBe("title:rateLimited")
    expect(input.body).toBe("429")
    expect(input.source).toBe("session")
    expect(input.level).toBe("warning")
  })

  it("omits the body when there is no raw text rather than sending an empty one", () => {
    expect(toNotificationInput(diag("timeout"), opts).body).toBeUndefined()
  })

  it("coalesces repeats of the same condition on one dedupe key", () => {
    const a = toNotificationInput(diag("healthCheckFailed", { meta: { agentId: "a1" } }), opts)
    const b = toNotificationInput(diag("healthCheckFailed", { meta: { agentId: "a1" } }), opts)
    expect(a.dedupeKey).toBe(b.dedupeKey)
    expect(a.dedupeKey).toBe("healthCheckFailed:a1")
  })

  it("carries only actions that still work with no live surface", () => {
    // `unauthorized` offers open-settings (global) + reauth (global); a code
    // whose actions are all host-scoped must not ship dead buttons.
    const input = toNotificationInput(diag("unauthorized"), opts)
    expect(input.actions?.map((a) => a.id)).toEqual(["open-settings", "reauth"])
    expect(toNotificationInput(diag("offline"), opts).actions).toBeUndefined()
  })

  it("caps actions at the three the center row persists", () => {
    const input = toNotificationInput(diag("initializationFailed", { meta: { agentId: "a1" } }), {
      ...opts,
    })
    expect((input.actions ?? []).length).toBeLessThanOrEqual(3)
  })

  it("counts toward the red badge only when the user must act", () => {
    expect(toNotificationInput(diag("settingsLoadFailed"), opts).directed).toBe(true)
    expect(toNotificationInput(diag("unauthorized"), opts).directed).toBe(true)
    // Ambient disclosure — a dot, not a count.
    expect(toNotificationInput(diag("fallbackToBuiltin"), opts).directed).toBe(false)
    expect(toNotificationInput(diag("timeout"), opts).directed).toBe(false)
  })

  it("uses the aggregate title when a burst was collapsed", () => {
    const input = toNotificationInput(diag("sidecarExited"), {
      ...opts,
      collapsed: true,
      collapsedTitle: "3 problems",
    })
    expect(input.title).toBe("3 problems")
  })

  it("falls back to the per-code title when collapsed with no aggregate", () => {
    expect(toNotificationInput(diag("sidecarExited"), { ...opts, collapsed: true }).title).toBe(
      "title:sidecarExited"
    )
  })

  it("keeps the code and id in meta for correlation", () => {
    expect(toNotificationInput(diag("timeout"), opts).meta).toEqual({
      diagnosticCode: "timeout",
      diagnosticId: "d1",
    })
  })
})
