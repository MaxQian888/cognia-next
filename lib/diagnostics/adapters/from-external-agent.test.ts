import type { ExternalAgentValiditySnapshot } from "@/types/agent/external-agent"

import { diagnoseExternalAgent } from "./from-external-agent"

const snapshot = (
  overrides: Partial<ExternalAgentValiditySnapshot> = {}
): ExternalAgentValiditySnapshot =>
  ({ canonicalReasonCode: "execution_failed", ...overrides }) as ExternalAgentValiditySnapshot

describe("diagnoseExternalAgent", () => {
  it("resolves the reason code through the shared table", () => {
    expect(
      diagnoseExternalAgent(snapshot({ canonicalReasonCode: "ecosystem_prerequisite_missing" }))
        ?.code
    ).toBe("prerequisiteMissing")
  })

  it("falls back to the last branch reason when there is no canonical one", () => {
    expect(
      diagnoseExternalAgent(
        snapshot({ canonicalReasonCode: undefined, lastBranchReasonCode: "health_check_failed" })
      )?.code
    ).toBe("healthCheckFailed")
  })

  it("returns null for a healthy agent", () => {
    expect(diagnoseExternalAgent(snapshot({ canonicalReasonCode: "ok" }))).toBeNull()
    expect(
      diagnoseExternalAgent(
        snapshot({ canonicalReasonCode: undefined, lastBranchReasonCode: undefined })
      )
    ).toBeNull()
    expect(diagnoseExternalAgent(undefined)).toBeNull()
  })

  it("turns the ecosystem docs URL into an action", () => {
    // `docsUrl` is per-ecosystem and is the only place install instructions
    // live; without it "Missing prerequisite" is a dead end.
    const out = diagnoseExternalAgent(
      snapshot({
        canonicalReasonCode: "ecosystem_prerequisite_missing",
        ecosystem: { docsUrl: "https://example.test/install" },
      })
    )
    expect(out?.actions).toContainEqual({
      kind: "open-external",
      url: "https://example.test/install",
    })
  })

  it("offers a reconnect bound to the specific agent", () => {
    const out = diagnoseExternalAgent(
      snapshot({ canonicalReasonCode: "health_check_failed" }),
      "a1"
    )
    expect(out?.actions).toContainEqual({ kind: "reconnect-external-agent", agentId: "a1" })
    expect(out?.meta.agentId).toBe("a1")
  })

  it("omits the reconnect action when no agent id is known", () => {
    expect(diagnoseExternalAgent(snapshot())?.actions).toEqual([])
  })

  it("passes recovery hint ids through for the renderer to translate", () => {
    // They are i18n key ids, not prose — resolving them here would drag a
    // locale into lib/.
    expect(
      diagnoseExternalAgent(snapshot({ recoveryHints: ["switchToAcp", "resaveConfiguration"] }))
        ?.recoveryHintKeys
    ).toEqual(["switchToAcp", "resaveConfiguration"])
  })

  it("defaults recovery hints to an empty list", () => {
    expect(diagnoseExternalAgent(snapshot())?.recoveryHintKeys).toEqual([])
  })

  it("keeps correlation ids so a report can name the exact turn", () => {
    const out = diagnoseExternalAgent(
      snapshot({
        correlation: {
          sessionId: "s1",
          turnId: "t1",
          traceId: "tr1",
          observedAt: new Date(0),
        },
      })
    )
    expect(out?.meta).toEqual({
      sessionId: "s1",
      turnId: "t1",
      traceId: "tr1",
      extra: { reasonCode: "execution_failed" },
    })
  })

  it("carries the runtime's own reason text as the raw message", () => {
    expect(diagnoseExternalAgent(snapshot({ canonicalReason: "exit code 127" }))?.message).toBe(
      "exit code 127"
    )
    expect(diagnoseExternalAgent(snapshot())?.message).toBe("")
  })
})
