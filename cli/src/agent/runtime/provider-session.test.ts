import type { AgentSession } from "../session-runner"

import { createProviderSessionLease, providerSessionKey } from "./provider-session"

function fakeSession(log: string[], label: string): AgentSession {
  return {
    send: async () => ({ text: "", usage: undefined }),
    close: () => log.push(`close:${label}`),
  } as unknown as AgentSession
}

describe("createProviderSessionLease", () => {
  it("builds on first use and reuses the same session for the same key", () => {
    const built: string[] = []
    const lease = createProviderSessionLease()
    const build = () => {
      built.push("built")
      return fakeSession([], "a")
    }

    const first = lease.session("k1", build)
    const second = lease.session("k1", build)

    expect(second).toBe(first)
    expect(built).toEqual(["built"])
  })

  it("keeps the conversation alive across turns — the whole point", () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    lease.session("k1", () => fakeSession(log, "a"))
    lease.session("k1", () => fakeSession(log, "b"))
    // Nothing closed between the two turns.
    expect(log).toEqual([])
  })

  it("reports which key is open", () => {
    const lease = createProviderSessionLease()
    expect(lease.openKey).toBeNull()
    lease.session("k1", () => fakeSession([], "a"))
    expect(lease.openKey).toBe("k1")
  })

  it("rebuilds — closing the old session — when the key changes", () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    const first = lease.session("builtin", () => fakeSession(log, "a"))
    const second = lease.session("codex", () => fakeSession(log, "b"))

    // A caller that switched backend must not keep talking to the old one.
    expect(second).not.toBe(first)
    expect(log).toEqual(["close:a"])
    expect(lease.openKey).toBe("codex")
  })

  it("closes the live session and forgets it", () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    lease.session("k1", () => fakeSession(log, "a"))
    lease.close()

    expect(log).toEqual(["close:a"])
    expect(lease.openKey).toBeNull()
  })

  it("makes close idempotent, and a no-op before anything was built", () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    lease.close()
    lease.session("k1", () => fakeSession(log, "a"))
    lease.close()
    lease.close()
    expect(log).toEqual(["close:a"])
  })

  it("builds a fresh session after a close", () => {
    const log: string[] = []
    const lease = createProviderSessionLease()
    const first = lease.session("k1", () => fakeSession(log, "a"))
    lease.close()
    const second = lease.session("k1", () => fakeSession(log, "b"))
    expect(second).not.toBe(first)
  })

  it("does not strand a half-dead session when close() throws", () => {
    const lease = createProviderSessionLease()
    const exploding = {
      close: () => {
        throw new Error("sidecar already gone")
      },
    } as unknown as AgentSession

    lease.session("k1", () => exploding)
    expect(() => lease.close()).toThrow("sidecar already gone")
    // The lease must have let go regardless: reusing a session whose close()
    // failed would hand the next turn a dead sidecar.
    expect(lease.openKey).toBeNull()
    const rebuilt = lease.session("k1", () => fakeSession([], "b"))
    expect(rebuilt).not.toBe(exploding)
  })
})

describe("providerSessionKey", () => {
  it("separates sessions that are genuinely not interchangeable", () => {
    const base = { sessionId: "s1", backendId: "builtin", model: "opus", cwd: "/repo" }
    expect(providerSessionKey(base)).toBe(providerSessionKey({ ...base }))
    expect(providerSessionKey({ ...base, backendId: "codex" })).not.toBe(providerSessionKey(base))
    expect(providerSessionKey({ ...base, sessionId: "s2" })).not.toBe(providerSessionKey(base))
    expect(providerSessionKey({ ...base, model: "sonnet" })).not.toBe(providerSessionKey(base))
    expect(providerSessionKey({ ...base, cwd: "/other" })).not.toBe(providerSessionKey(base))
  })

  it("tolerates the optional fields being absent", () => {
    expect(providerSessionKey({ sessionId: "s1", backendId: "builtin" })).toBe(
      providerSessionKey({ sessionId: "s1", backendId: "builtin" })
    )
  })

  it("does not fold in per-turn knobs, which would discard context on every toggle", () => {
    // Approval mode and the tool allow-list are re-applied per `send`. If they
    // were part of the key, flipping one would rebuild the session and lose the
    // conversation.
    const key = providerSessionKey({ sessionId: "s1", backendId: "builtin", model: "opus" })
    expect(key).not.toContain("approval")
    expect(key).not.toContain("tools")
  })
})
