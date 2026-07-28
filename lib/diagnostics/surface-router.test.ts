import { createDiagnostic } from "@cognia/diagnostics"
import type { CogniaDiagnostic } from "@cognia/diagnostics"

import { CASCADE_THRESHOLD } from "./cascade"
import { diagnosticDedupeKey, resolveSurface, type SurfaceContext } from "./surface-router"

const diag = (code: Parameters<typeof createDiagnostic>[0], init = {}): CogniaDiagnostic =>
  createDiagnostic(code, { source: "chat", now: () => 0, id: "d1", ...init })

const ctx = (over: Partial<SurfaceContext> = {}): SurfaceContext => ({
  origin: { kind: "chat", id: "s1" },
  watching: true,
  hasInlineHost: true,
  recentCount: 1,
  ...over,
})

describe("resolveSurface", () => {
  it("takes over the screen only for a fatal boot failure", () => {
    expect(resolveSurface(diag("dbUpgradeBlocked"), ctx({ bootScope: true }))).toEqual({
      surface: "modal",
    })
    // The same severity outside boot does NOT get to seize the screen.
    expect(resolveSurface(diag("dbUpgradeBlocked"), ctx()).surface).not.toBe("modal")
  })

  it("collapses a burst into one aggregate rather than announcing each", () => {
    // A sidecar crash fails every in-flight session at once.
    expect(resolveSurface(diag("sidecarExited"), ctx({ recentCount: CASCADE_THRESHOLD }))).toEqual({
      surface: "center",
      collapsed: true,
    })
  })

  it("suppresses the burst even while the user is watching", () => {
    // Otherwise a storm fills the pane with cards instead of toasts — same bug,
    // different surface.
    expect(
      resolveSurface(diag("timeout"), ctx({ recentCount: CASCADE_THRESHOLD + 4 })).collapsed
    ).toBe(true)
  })

  it("renders inline — and only inline — when the user is looking at the host", () => {
    // The double-notification bug: an inline card AND a sonner toast for one 429.
    expect(resolveSurface(diag("rateLimited"), ctx())).toEqual({ surface: "inline" })
  })

  it("falls back to a toast when the watched surface cannot host a card", () => {
    expect(resolveSurface(diag("rateLimited"), ctx({ hasInlineHost: false })).surface).toBe("toast")
  })

  it("puts a lasting condition on a badge, not on an event surface", () => {
    // `sidecarUnreachable` stays true until someone restarts it; a toast per
    // retry tick is exactly the noise this prevents.
    expect(resolveSurface(diag("sidecarUnreachable"), ctx({ watching: false }))).toEqual({
      surface: "badge",
      banner: false,
    })
  })

  it("adds a banner only when the lasting condition is app-stopping", () => {
    expect(resolveSurface(diag("settingsLoadFailed"), ctx({ watching: false })).banner).toBe(true)
    expect(resolveSurface(diag("offline"), ctx({ watching: false })).banner).toBe(false)
  })

  it("routes a one-shot failure the user missed to the notification center", () => {
    expect(resolveSurface(diag("serverError"), ctx({ watching: false }))).toEqual({
      surface: "center",
    })
  })

  it("never renders a background-origin diagnostic as a toast", () => {
    // Background work has no surface the user is 'on', so a toast would appear
    // out of nowhere with no context.
    const decision = resolveSurface(
      diag("dispatchFailed"),
      ctx({ origin: { kind: "background" }, watching: true, hasInlineHost: false })
    )
    expect(decision.surface).toBe("center")
  })
})

describe("diagnosticDedupeKey", () => {
  it("scopes by the most specific id available", () => {
    expect(
      diagnosticDedupeKey(diag("healthCheckFailed", { meta: { agentId: "a1", sessionId: "s1" } }))
    ).toBe("healthCheckFailed:a1")
    expect(diagnosticDedupeKey(diag("timeout", { meta: { sessionId: "s1" } }))).toBe("timeout:s1")
    expect(diagnosticDedupeKey(diag("timeout", { meta: { adapterId: "lark" } }))).toBe(
      "timeout:lark"
    )
  })

  it("uses the run id when no session or agent scopes the failure", () => {
    // Scheduled and workflow runs carry a runId and nothing else.
    expect(diagnosticDedupeKey(diag("executionFailed", { meta: { runId: "r7" } }))).toBe(
      "executionFailed:r7"
    )
  })

  it("falls back to the origin id, then to a global scope", () => {
    expect(diagnosticDedupeKey(diag("timeout"), { kind: "chat", id: "s9" })).toBe("timeout:s9")
    expect(diagnosticDedupeKey(diag("timeout"))).toBe("timeout:global")
  })

  it("keeps distinct codes on the same scope apart", () => {
    const meta = { sessionId: "s1" }
    expect(diagnosticDedupeKey(diag("timeout", { meta }))).not.toBe(
      diagnosticDedupeKey(diag("serverError", { meta }))
    )
  })
})
