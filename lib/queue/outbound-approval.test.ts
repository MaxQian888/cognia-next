import { HostConsentRequiredError } from "@/lib/tauri/admin-lease"
import {
  __resetOutboundApprovalForTests,
  DENIED_COOLDOWN_MS,
  ensureOutboundApproval,
  interactiveOutboundCommands,
  outboundConsentCode,
  PENDING_NO_CODE,
  clearOutboundApproval,
  subscribeOutboundApproval,
  withOutboundApproval,
} from "./outbound-approval"

type Deps = Parameters<typeof ensureOutboundApproval>[1]

let clock = 1_000_000

let activeScope: { accountId: string; targetId: string; routingGeneration: number } | null = {
  accountId: "acct-a",
  targetId: "host-a",
  routingGeneration: 1,
}

function deps(over: Partial<NonNullable<Deps>> = {}): Deps {
  return {
    getActiveScope: (() => (activeScope ? { ...activeScope } : null)) as never,
    getCommandDescriptor: ((name: string) =>
      name === "host_state_submit" ? { approval: "interactive" } : { approval: "none" }) as never,
    getRuntimeSnapshot: (() => ({ target: { kind: "companion" } })) as never,
    issueAdminLease: (async (operations: string[]) => ({
      token: "lease-1",
      operations,
      expiresAt: clock + 600_000,
    })) as never,
    now: () => clock,
    ...over,
  }
}

beforeEach(() => {
  clock = 1_000_000
  activeScope = { accountId: "acct-a", targetId: "host-a", routingGeneration: 1 }
  __resetOutboundApprovalForTests()
})

describe("ensureOutboundApproval", () => {
  // The defect: the queue dispatched every job bare, so `host_state_submit`
  // answered `interactive_approval_required` from a paired client and the chat
  // turn's user message never reached the Host. The composer cleared and
  // nothing else happened, because the queue records a delivery failure rather
  // than surfacing one.
  it("takes a lease for an interactive command and attaches it at dispatch", async () => {
    const d = deps()
    await expect(ensureOutboundApproval("host_state_submit", d)).resolves.toBe("held")
    expect(withOutboundApproval("host_state_submit", { actions: [] }, d)).toEqual({
      actions: [],
      adminLease: "lease-1",
    })
  })

  it("asks for every interactive queue command at once, not just this row's", async () => {
    // Ten prompts in a row trains an operator to approve without reading. One
    // confirmation buys a bounded window covering the whole queue.
    const seen: string[][] = []
    const gated = new Set(["host_state_submit", "workflow_delete"])
    const d = deps({
      getCommandDescriptor: ((name: string) => ({
        approval: gated.has(name) ? "interactive" : "none",
      })) as never,
      issueAdminLease: (async (operations: string[]) => {
        seen.push(operations)
        return { token: "lease-1", operations, expiresAt: clock + 600_000 }
      }) as never,
    })

    await ensureOutboundApproval("host_state_submit", d)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(interactiveOutboundCommands(d))
    expect(seen[0]).toEqual(expect.arrayContaining(["host_state_submit", "workflow_delete"]))
  })

  it("leaves an ungated command untouched, so it pays for no lease", async () => {
    const issue = jest.fn()
    const d = deps({ issueAdminLease: issue as never })
    await expect(ensureOutboundApproval("message_send", d)).resolves.toBe("not-required")
    expect(withOutboundApproval("message_send", { text: "hi" }, d)).toEqual({ text: "hi" })
    expect(issue).not.toHaveBeenCalled()
  })

  // No client target means this process IS the host: the command dispatches
  // in-process, and asking it for a lease would fail a call that needs none.
  it("skips the lease on a shell with local authority", async () => {
    const issue = jest.fn()
    const d = deps({
      getRuntimeSnapshot: (() => ({ target: null })) as never,
      issueAdminLease: issue as never,
    })
    await expect(ensureOutboundApproval("host_state_submit", d)).resolves.toBe("not-required")
    expect(withOutboundApproval("host_state_submit", { actions: [] }, d)).toEqual({ actions: [] })
    expect(issue).not.toHaveBeenCalled()
  })

  it("reuses a live lease instead of asking again on every drain pass", async () => {
    const issue = jest.fn(async (operations: string[]) => ({
      token: "lease-1",
      operations,
      expiresAt: clock + 600_000,
    }))
    const d = deps({ issueAdminLease: issue as never })

    await ensureOutboundApproval("host_state_submit", d)
    await ensureOutboundApproval("host_state_submit", d)
    await ensureOutboundApproval("host_state_submit", d)

    expect(issue).toHaveBeenCalledTimes(1)
  })

  it("re-asks once the lease is close enough to expiry to lapse mid-drain", async () => {
    const issue = jest.fn(async (operations: string[]) => ({
      token: "lease-1",
      operations,
      expiresAt: clock + 60_000,
    }))
    const d = deps({ issueAdminLease: issue as never })

    await ensureOutboundApproval("host_state_submit", d)
    clock += 40_000
    await ensureOutboundApproval("host_state_submit", d)

    expect(issue).toHaveBeenCalledTimes(2)
  })

  it("reads an already-expired window as a refusal, not a brief yes", async () => {
    const d = deps({
      issueAdminLease: (async (operations: string[]) => ({
        token: "lease-1",
        operations,
        expiresAt: clock - 1,
      })) as never,
    })
    await expect(ensureOutboundApproval("host_state_submit", d)).resolves.toBe("blocked")
  })

  it("collapses concurrent pre-flights onto one request", async () => {
    const issue = jest.fn(async (operations: string[]) => ({
      token: "lease-1",
      operations,
      expiresAt: clock + 600_000,
    }))
    const d = deps({ issueAdminLease: issue as never })

    const states = await Promise.all([
      ensureOutboundApproval("host_state_submit", d),
      ensureOutboundApproval("host_state_submit", d),
    ])

    expect(states).toEqual(["held", "held"])
    expect(issue).toHaveBeenCalledTimes(1)
  })
})

describe("a host that is waiting on a human", () => {
  const consentDeps = (code: string | null = "A1B2C3D4") =>
    deps({
      issueAdminLease: (async () => {
        throw new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED", code)
      }) as never,
    })

  // The old shape let this reach the queue as an ordinary delivery failure:
  // attempts incremented, the backoff grew, and the row deadlettered while a
  // person was still being asked. The user's message went quiet all over again.
  it("blocks rather than throwing, so the row is never charged an attempt", async () => {
    await expect(ensureOutboundApproval("host_state_submit", consentDeps())).resolves.toBe(
      "blocked"
    )
  })

  it("keeps the code an approver needs in order to answer", async () => {
    await ensureOutboundApproval("host_state_submit", consentDeps())
    expect(outboundConsentCode()).toBe("A1B2C3D4")
  })

  it("still says an approval is pending against a host that named no code", async () => {
    await ensureOutboundApproval("host_state_submit", consentDeps(null))
    expect(outboundConsentCode()).toBe(PENDING_NO_CODE)
  })

  it("does not attach a lease it never received", async () => {
    const d = consentDeps()
    await ensureOutboundApproval("host_state_submit", d)
    expect(withOutboundApproval("host_state_submit", { actions: [] }, d)).toEqual({ actions: [] })
  })

  it("holds off re-asking for the cooldown, so a kick storm is not a prompt storm", async () => {
    const issue = jest.fn(async () => {
      throw new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED", "Z")
    })
    const d = deps({ issueAdminLease: issue as never })

    await ensureOutboundApproval("host_state_submit", d)
    await ensureOutboundApproval("host_state_submit", d)
    expect(issue).toHaveBeenCalledTimes(1)

    clock += DENIED_COOLDOWN_MS + 1
    await ensureOutboundApproval("host_state_submit", d)
    expect(issue).toHaveBeenCalledTimes(2)
  })

  it("asks again immediately once the approval is answered out of band", async () => {
    // The cooldown must not outlive the thing it was protecting against, or a
    // message the user watched being approved still would not move.
    const issue = jest.fn(async () => {
      throw new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED", "Z")
    })
    const d = deps({ issueAdminLease: issue as never })

    await ensureOutboundApproval("host_state_submit", d)
    clearOutboundApproval()
    await ensureOutboundApproval("host_state_submit", d)

    expect(issue).toHaveBeenCalledTimes(2)
    expect(outboundConsentCode()).toBe("Z")
  })

  it("tells subscribers so a banner can show the wait without polling", async () => {
    const listener = jest.fn()
    subscribeOutboundApproval(listener)
    await ensureOutboundApproval("host_state_submit", consentDeps())
    expect(listener).toHaveBeenCalled()
  })

  it("keeps a flat refusal apart from a pending approval", async () => {
    await ensureOutboundApproval(
      "host_state_submit",
      deps({
        issueAdminLease: (async () => {
          throw new Error("device is not permitted")
        }) as never,
      })
    )
    expect(outboundConsentCode()).toBeNull()
  })
})

describe("withOutboundApproval", () => {
  it("tolerates a job with no payload", async () => {
    const d = deps()
    await ensureOutboundApproval("host_state_submit", d)
    expect(withOutboundApproval("host_state_submit", undefined, d)).toEqual({
      adminLease: "lease-1",
    })
  })

  it("never mints on its own, so a dispatch cannot re-open the background ask", () => {
    const issue = jest.fn()
    expect(
      withOutboundApproval(
        "host_state_submit",
        { actions: [] },
        deps({ issueAdminLease: issue as never })
      )
    ).toEqual({ actions: [] })
    expect(issue).not.toHaveBeenCalled()
  })
})

describe("interactiveOutboundCommands", () => {
  it("names the real gated commands from the live descriptor table", () => {
    // Derived, never hand-kept: a queue command whose approval changes must
    // not need this list edited to stay covered by the same lease.
    expect(interactiveOutboundCommands()).toContain("host_state_submit")
  })
})

describe("the lease is scoped to the runtime target it was minted for", () => {
  // A lease is device-bound AND host-bound. The cache held one module-global
  // token, so after a target switch the next drain read Host A's live lease as
  // a cache hit and attached it to a Host B command — which Host B refuses,
  // and which is a credential from one host offered to another.
  const leaseFor = (label: string) =>
    jest.fn(async (operations: string[]) => ({
      token: `lease-${label}`,
      operations,
      expiresAt: clock + 600_000,
    }))

  it("never returns or attaches Host A's token for Host B", async () => {
    const issue = leaseFor("a")
    const d = deps({ issueAdminLease: issue as never })
    await expect(ensureOutboundApproval("host_state_submit", d)).resolves.toBe("held")
    expect(withOutboundApproval("host_state_submit", { actions: [] }, d)).toEqual({
      actions: [],
      adminLease: "lease-a",
    })

    activeScope = { accountId: "acct-a", targetId: "host-b", routingGeneration: 2 }

    // Nothing is attached before a lease is taken under the new scope...
    expect(withOutboundApproval("host_state_submit", { actions: [] }, d)).toEqual({ actions: [] })

    // ...and the pre-flight asks Host B rather than reporting a cache hit.
    const issueB = leaseFor("b")
    const dB = deps({ issueAdminLease: issueB as never })
    await expect(ensureOutboundApproval("host_state_submit", dB)).resolves.toBe("held")
    expect(issueB).toHaveBeenCalledTimes(1)
    expect(withOutboundApproval("host_state_submit", { actions: [] }, dB)).toEqual({
      actions: [],
      adminLease: "lease-b",
    })
  })

  it("re-asks after a sign-out swaps the account under the same target id", async () => {
    const issue = leaseFor("a")
    const d = deps({ issueAdminLease: issue as never })
    await ensureOutboundApproval("host_state_submit", d)
    expect(issue).toHaveBeenCalledTimes(1)

    activeScope = { accountId: "acct-b", targetId: "host-a", routingGeneration: 1 }
    await ensureOutboundApproval("host_state_submit", d)
    expect(issue).toHaveBeenCalledTimes(2)
  })

  it("re-asks after a re-pair bumps the routing generation", async () => {
    // Same account, same host id, new routing generation: the transport was
    // torn down and rebuilt, so the old device binding is gone with it.
    const issue = leaseFor("a")
    const d = deps({ issueAdminLease: issue as never })
    await ensureOutboundApproval("host_state_submit", d)
    activeScope = { accountId: "acct-a", targetId: "host-a", routingGeneration: 2 }
    await ensureOutboundApproval("host_state_submit", d)
    expect(issue).toHaveBeenCalledTimes(2)
  })

  it("does not carry a refusal cooldown across a target switch", async () => {
    const issue = jest.fn(async () => {
      throw new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED", "Z")
    })
    const d = deps({ issueAdminLease: issue as never })
    await expect(ensureOutboundApproval("host_state_submit", d)).resolves.toBe("blocked")
    await ensureOutboundApproval("host_state_submit", d)
    expect(issue).toHaveBeenCalledTimes(1)

    activeScope = { accountId: "acct-a", targetId: "host-b", routingGeneration: 2 }
    await ensureOutboundApproval("host_state_submit", d)
    expect(issue).toHaveBeenCalledTimes(2)
  })

  it("refuses to install a lease that arrives after the scope moved", async () => {
    // The request was already in flight when the user switched hosts. Its
    // answer belongs to the host that is no longer active, so it must not
    // become the cached lease for the one that is.
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const issue = jest.fn(async (operations: string[]) => {
      await gate
      return { token: "lease-a", operations, expiresAt: clock + 600_000 }
    })
    const d = deps({ issueAdminLease: issue as never })

    const pending = ensureOutboundApproval("host_state_submit", d)
    activeScope = { accountId: "acct-a", targetId: "host-b", routingGeneration: 2 }
    release!()

    await expect(pending).resolves.toBe("blocked")
    expect(withOutboundApproval("host_state_submit", { actions: [] }, d)).toEqual({ actions: [] })

    // And the next pre-flight is a fresh ask, not the abandoned one.
    const issueB = leaseFor("b")
    await expect(
      ensureOutboundApproval("host_state_submit", deps({ issueAdminLease: issueB as never }))
    ).resolves.toBe("held")
    expect(issueB).toHaveBeenCalledTimes(1)
  })

  it("refuses to install a lease that arrives after an explicit clear", async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const issue = jest.fn(async (operations: string[]) => {
      await gate
      return { token: "lease-a", operations, expiresAt: clock + 600_000 }
    })
    const d = deps({ issueAdminLease: issue as never })

    const pending = ensureOutboundApproval("host_state_submit", d)
    clearOutboundApproval()
    release!()

    await expect(pending).resolves.toBe("blocked")
    expect(withOutboundApproval("host_state_submit", { actions: [] }, d)).toEqual({ actions: [] })
  })

  it("keeps caching when no scope is installed, which is the local-authority case", async () => {
    activeScope = null
    const issue = leaseFor("a")
    const d = deps({ issueAdminLease: issue as never })
    await ensureOutboundApproval("host_state_submit", d)
    await ensureOutboundApproval("host_state_submit", d)
    expect(issue).toHaveBeenCalledTimes(1)
  })
})
