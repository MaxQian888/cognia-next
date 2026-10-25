import type { UnattendedParkDeps } from "@/lib/claude/unattended-park"
import type { CapturePermissionDecision } from "@/lib/claude/run-and-capture"

import {
  heldIntegrationJobSessionId,
  isHeldIntegrationJobPushed,
  pushHeldIntegrationJob,
  withdrawHeldIntegrationJob,
  type HeldIntegrationJobPush,
} from "./outbound-hold"

const review = {
  targets: [
    { kind: "repository" as const, channel: "github", recipient: "github:github.com/acme/web" },
  ],
  unauthorized: [
    { kind: "repository" as const, channel: "github", recipient: "github:github.com/acme/web" },
  ],
  enforced: true,
}

type Answer = CapturePermissionDecision | "expire" | "wait"

function fakeDeps(answer: Answer) {
  const calls = {
    interrupts: [] as Array<Parameters<UnattendedParkDeps["createInterrupt"]>[0]>,
    announced: [] as Array<Parameters<UnattendedParkDeps["announce"]>[1]>,
    awaited: [] as Array<[string, string]>,
    finished: [] as string[],
  }
  const deps: Partial<UnattendedParkDeps> = {
    openRun: async () => undefined,
    finishRun: async (_runId, status) => {
      calls.finished.push(status)
    },
    createInterrupt: async (input) => {
      calls.interrupts.push(input)
    },
    expireInterrupt: async () => undefined,
    announce: async (_interrupt, context) => {
      calls.announced.push(context)
    },
    announceResolved: async () => undefined,
    awaitDecision: (sessionId, requestId, options) => {
      calls.awaited.push([sessionId, requestId])
      if (answer === "expire") {
        options.onExpire()
        return Promise.resolve({ decision: "deny" })
      }
      if (answer === "wait") {
        return new Promise((resolve) => {
          options.signal?.addEventListener("abort", () => {
            options.onExpire()
            resolve({ decision: "deny" })
          })
        })
      }
      return Promise.resolve(answer)
    },
    newId: () => "id",
  }
  return { deps, calls }
}

function push(answer: Answer, onAnswer = jest.fn(async () => undefined)) {
  const { deps, calls } = fakeDeps(answer)
  const input: HeldIntegrationJobPush = {
    jobId: "job_1",
    toolName: "integration__github-delivery__github__commentpr",
    label: "GitHub: Comment on pull request",
    origin: "bot",
    review,
    onAnswer,
    park: { deps },
  }
  return { input, calls, onAnswer }
}

describe("pushHeldIntegrationJob", () => {
  it("asks as an outbound request with the write's recipients, filed under the job", async () => {
    const { input, calls, onAnswer } = push({ decision: "allow" })
    await pushHeldIntegrationJob(input)
    expect(calls.awaited).toEqual([
      [heldIntegrationJobSessionId("job_1"), "integration-hold:job_1"],
    ])
    expect(calls.interrupts[0]).toMatchObject({
      toolName: "integration__github-delivery__github__commentpr",
      requestDigest: "integration-hold:job_1",
      permissionClass: "outbound",
    })
    expect(calls.announced[0]).toEqual({ origin: "bot", permissionClass: "outbound" })
    expect(onAnswer).toHaveBeenCalledWith({ kind: "approved" })
    expect(calls.finished).toEqual(["completed"])
    expect(isHeldIntegrationJobPushed("job_1")).toBe(false)
  })

  it("passes on an approval for the rest of the request", async () => {
    const { input, onAnswer } = push({ decision: "allow", forRequest: true })
    await pushHeldIntegrationJob(input)
    expect(onAnswer).toHaveBeenCalledWith({ kind: "approved", forRequest: true })
  })

  it("passes on a refusal", async () => {
    const { input, onAnswer } = push({ decision: "deny", message: "no" })
    await pushHeldIntegrationJob(input)
    expect(onAnswer).toHaveBeenCalledWith({ kind: "denied" })
  })

  it("leaves the job held when nobody answers", async () => {
    const { input, calls, onAnswer } = push("expire")
    await pushHeldIntegrationJob(input)
    expect(onAnswer).not.toHaveBeenCalled()
    expect(calls.finished).toEqual(["cancelled"])
  })

  it("is withdrawn when a person answers in the hub first", async () => {
    const { input, onAnswer } = push("wait")
    const pending = pushHeldIntegrationJob(input)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(isHeldIntegrationJobPushed("job_1")).toBe(true)
    withdrawHeldIntegrationJob("job_1")
    await pending
    expect(onAnswer).not.toHaveBeenCalled()
    expect(isHeldIntegrationJobPushed("job_1")).toBe(false)
    // Withdrawing a job with no push is a no-op.
    expect(() => withdrawHeldIntegrationJob("job_2")).not.toThrow()
  })

  it("keeps the job held when answering it fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const { input } = push(
      { decision: "allow" },
      jest.fn(async () => {
        throw new Error("db closed")
      })
    )
    await expect(pushHeldIntegrationJob(input)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
