import type { PermissionRequestEvent } from "@cognia/agent-config-types"

import type { CapturePermissionDecision } from "./run-and-capture"
import {
  UNATTENDED_PARK_TTL_MS,
  UNATTENDED_SIDECAR_APPROVAL_TTL_MS,
  createUnattendedPark,
  parkedInterruptId,
  parkedInterruptTitle,
  type UnattendedParkDeps,
} from "./unattended-park"

function request(fields: Partial<PermissionRequestEvent> = {}): PermissionRequestEvent {
  return {
    type: "permission_request",
    sessionId: "s1",
    requestId: "req-1",
    toolUseID: "tu-1",
    toolName: "mcp__cognia-plugin-tools__im_send",
    input: { text: "hi" },
    permissionClass: "outbound",
    ...fields,
  }
}

function harness(answer: (options: { onExpire: () => void }) => CapturePermissionDecision) {
  const calls: string[] = []
  const deps: UnattendedParkDeps = {
    openRun: jest.fn(async (input) => {
      calls.push(`open ${input.runId} ${input.title}`)
    }),
    finishRun: jest.fn(async (runId, status) => {
      calls.push(`finish ${runId} ${status}`)
    }),
    createInterrupt: jest.fn(async (input) => {
      calls.push(`interrupt ${input.id} ${input.title} exp=${input.expiresAt}`)
      expect(input.permissionClass).toBe("outbound")
    }),
    expireInterrupt: jest.fn(async (_runId, interruptId) => {
      calls.push(`expire ${interruptId}`)
    }),
    announce: jest.fn(async (interrupt, context) => {
      calls.push(`announce ${interrupt.id} ${context.origin} ${context.permissionClass}`)
    }),
    announceResolved: jest.fn(async (input) => {
      calls.push(`resolved ${input.interruptId} ${input.status}`)
    }),
    awaitDecision: jest.fn(async (sessionId, requestId, options) => {
      calls.push(`await ${sessionId}:${requestId} ttl=${options.ttlMs}`)
      return answer(options)
    }),
    newId: () => "n1",
  }
  return { deps, calls }
}

describe("unattended park", () => {
  it("leaves the sidecar's own ceiling a little past the park's", () => {
    expect(UNATTENDED_SIDECAR_APPROVAL_TTL_MS).toBeGreaterThan(UNATTENDED_PARK_TTL_MS)
  })

  it("names the tool and the class that made it ask", () => {
    expect(parkedInterruptTitle(request())).toBe(
      "Approve mcp__cognia-plugin-tools__im_send (outbound message)"
    )
    expect(parkedInterruptTitle(request({ permissionClass: undefined, toolName: "Bash" }))).toBe(
      "Approve Bash"
    )
    expect(parkedInterruptId("r", "q")).toBe("tool-interrupt:r:q")
  })

  it("opens one run, raises an interrupt, wakes the phone and resumes on approval", async () => {
    const { deps, calls } = harness(() => ({ decision: "allow" }))
    const park = createUnattendedPark({
      origin: "scheduler",
      sessionId: "s1",
      label: "Scheduled task: Digest",
      now: () => 1_000,
      deps,
    })
    await expect(park.park(request())).resolves.toEqual({
      kind: "approved",
      decision: { decision: "allow" },
    })
    await park.park(request({ requestId: "req-2" }))
    expect(deps.openRun).toHaveBeenCalledTimes(1)
    expect(park.runId()).toBe("unattended:s1:n1")
    expect(calls).toEqual([
      "open unattended:s1:n1 Scheduled task: Digest",
      `interrupt tool-interrupt:unattended:s1:n1:req-1 Approve mcp__cognia-plugin-tools__im_send (outbound message) exp=${1_000 + UNATTENDED_PARK_TTL_MS}`,
      "announce tool-interrupt:unattended:s1:n1:req-1 scheduler outbound",
      `await s1:req-1 ttl=${UNATTENDED_PARK_TTL_MS}`,
      "resolved tool-interrupt:unattended:s1:n1:req-1 approved",
      `interrupt tool-interrupt:unattended:s1:n1:req-2 Approve mcp__cognia-plugin-tools__im_send (outbound message) exp=${1_000 + UNATTENDED_PARK_TTL_MS}`,
      "announce tool-interrupt:unattended:s1:n1:req-2 scheduler outbound",
      `await s1:req-2 ttl=${UNATTENDED_PARK_TTL_MS}`,
      "resolved tool-interrupt:unattended:s1:n1:req-2 approved",
    ])
  })

  it("reports a person's denial with their message", async () => {
    const { deps, calls } = harness(() => ({ decision: "deny", message: "not today" }))
    const park = createUnattendedPark({ origin: "bot", sessionId: "s1", label: "Bot", deps })
    await expect(park.park(request())).resolves.toEqual({ kind: "denied", message: "not today" })
    expect(calls.at(-1)).toBe("resolved tool-interrupt:unattended:s1:n1:req-1 denied")
  })

  it("expires the interrupt when nobody answers in time", async () => {
    const { deps, calls } = harness(({ onExpire }) => {
      onExpire()
      return { decision: "deny", message: "approval timed out" }
    })
    const park = createUnattendedPark({
      origin: "bot",
      sessionId: "s1",
      label: "Bot",
      ttlMs: 50,
      deps,
    })
    await expect(park.park(request())).resolves.toEqual({ kind: "expired" })
    expect(calls).toContain("await s1:req-1 ttl=50")
    expect(calls.slice(-2)).toEqual([
      "expire tool-interrupt:unattended:s1:n1:req-1",
      "resolved tool-interrupt:unattended:s1:n1:req-1 expired",
    ])
  })

  it("withdraws the question when the turn ends first", async () => {
    const controller = new AbortController()
    const { deps } = harness(({ onExpire }) => {
      controller.abort()
      onExpire()
      return { decision: "deny", message: "approval owner ended" }
    })
    const park = createUnattendedPark({
      origin: "bot",
      sessionId: "s1",
      label: "Bot",
      signal: controller.signal,
      deps,
    })
    await expect(park.park(request())).resolves.toEqual({ kind: "withdrawn" })
    expect(deps.expireInterrupt).toHaveBeenCalled()
  })

  it("closes the run once, and never opens one for a turn that did not park", async () => {
    const { deps, calls } = harness(() => ({ decision: "allow" }))
    const quiet = createUnattendedPark({ origin: "bot", sessionId: "s1", label: "Bot", deps })
    await quiet.finish("completed")
    expect(deps.openRun).not.toHaveBeenCalled()
    expect(deps.finishRun).not.toHaveBeenCalled()

    const parked = createUnattendedPark({ origin: "bot", sessionId: "s1", label: "Bot", deps })
    await parked.park(request())
    await parked.finish("completed")
    await parked.finish("failed")
    expect(calls.filter((c) => c.startsWith("finish"))).toEqual([
      "finish unattended:s1:n1 completed",
    ])
  })

  it("never lets a lost wake-up or bookkeeping failure fail the decision", async () => {
    const { deps } = harness(() => ({ decision: "allow" }))
    deps.announce = jest.fn().mockRejectedValue(new Error("bus down"))
    deps.announceResolved = jest.fn().mockRejectedValue(new Error("bus down"))
    const park = createUnattendedPark({ origin: "bot", sessionId: "s1", label: "Bot", deps })
    await expect(park.park(request())).resolves.toMatchObject({ kind: "approved" })
  })
})
