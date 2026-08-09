import type { CdpAuditEvent, CdpGrant } from "@/types/browser-developer"
import { authorizeCdpAccess, type CdpAccessRequest } from "./cdp-policy"

const request = (overrides: Partial<CdpAccessRequest> = {}): CdpAccessRequest => ({
  grantId: "grant-1",
  sessionId: "session-1",
  browserSessionId: "browser-1",
  pageUrl: "http://localhost:3000/private?token=secret",
  capability: "dom",
  method: "DOM.getDocument",
  executionTarget: "local",
  ...overrides,
})

const grant: CdpGrant = {
  id: "grant-1",
  sessionId: "session-1",
  browserSessionId: "browser-1",
  origin: "http://localhost:3000",
  capabilities: ["dom"],
  grantedAt: 1,
  expiresAt: 20,
}

describe("controlled CDP policy", () => {
  const events: CdpAuditEvent[] = []
  const deps = {
    isTauriRuntime: () => true,
    now: () => 10,
    createAuditId: () => `audit-${events.length + 1}`,
    findGrant: jest.fn(async (_query: unknown): Promise<CdpGrant | undefined> => grant),
    appendAudit: jest.fn(async (event: CdpAuditEvent) => {
      events.push(event)
    }),
  }

  beforeEach(() => {
    events.length = 0
    deps.findGrant.mockClear()
    deps.appendAudit.mockClear()
  })

  it("authorizes an exact local-Tauri session grant and redacts the audited URL", async () => {
    await expect(authorizeCdpAccess(request(), deps)).resolves.toEqual({
      allowed: true,
      reason: "allowed",
      grant,
    })
    expect(deps.findGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        browserSessionId: "browser-1",
        origin: "http://localhost:3000",
      })
    )
    expect(events).toEqual([
      expect.objectContaining({ origin: "http://localhost:3000", outcome: "used" }),
    ])
    expect(JSON.stringify(events)).not.toContain("token=secret")
  })

  it.each([
    ["web runtime", { isTauriRuntime: () => false }, "tauri_required"],
    ["remote target", {}, "local_target_required"],
  ] as const)("rejects %s before grant lookup", async (_name, override, reason) => {
    const input =
      reason === "local_target_required" ? request({ executionTarget: "remote" }) : request()
    await expect(authorizeCdpAccess(input, { ...deps, ...override })).resolves.toEqual({
      allowed: false,
      reason,
    })
    expect(deps.findGrant).not.toHaveBeenCalled()
    expect(events[0]).toEqual(expect.objectContaining({ outcome: "rejected", reason }))
  })

  it("rejects cross-session or expired authority returned as inactive by the grant store", async () => {
    deps.findGrant.mockResolvedValueOnce(undefined)
    await expect(
      authorizeCdpAccess(request({ sessionId: "other-session" }), deps)
    ).resolves.toEqual({ allowed: false, reason: "grant_missing_or_inactive" })
    expect(events[0].reason).toBe("grant_missing_or_inactive")
  })

  it("does not persist malformed URLs in rejection audits", async () => {
    await expect(
      authorizeCdpAccess(request({ pageUrl: "not a url?token=secret" }), deps)
    ).resolves.toEqual({
      allowed: false,
      reason: "invalid_origin",
    })
    expect(events[0].origin).toBe("http://invalid.local")
    expect(JSON.stringify(events)).not.toContain("token=secret")
  })
})
