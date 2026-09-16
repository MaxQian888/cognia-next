/** @jest-environment jsdom */
import type { UIMessage } from "ai"
import type { RouterFusionRunStamp, RouterFusionRunSummary } from "@cognia/agent-config-types"
import type { CogniaDiagnostic } from "@cognia/diagnostics"

import { STEER_PREFIX } from "@/lib/claude/steer"
import {
  RouterFusionInfrastructureError,
  RouterFusionRefusalError,
  RouterFusionUnavailableError,
} from "@/lib/router-fusion/gate/faults"
import { useChatStore } from "@/stores/chat"
import { useFusionProgressStore } from "@/stores/chat/fusion-progress-store"

import {
  __resetFusionChatTurnsForTesting,
  fusionChatTurnActive,
  fusionTranscriptOf,
  routerFusionSendDiagnostic,
  runFusionChatTurn,
  stopFusionChatTurn,
  type FusionChatTurnDeps,
} from "./router-fusion-chat-turn"

const SESSION = "s-fusion"

const stamp: RouterFusionRunStamp = {
  runId: "run-1",
  decisionId: "d-1",
  actionId: "panel_review",
  mode: "panel",
  ruleId: "R1_explicit_mode",
  requested: "panel",
  roles: { judge: "openai::gpt-5" },
  budgetMode: "tracked",
  capMicrousd: 2_000_000,
  acceptanceProfile: "evidence_review",
}

const summary = { runId: "run-1", spentMicrousd: 5 } as RouterFusionRunSummary

const user = (text: string, id = "u1"): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
})

const answer = {
  id: "rf-run-1-answer",
  role: "assistant" as const,
  parts: [{ type: "text" as const, text: "the verified answer" }],
  metadata: { routerFusion: { runId: "run-1", mode: "panel", origin: "chat" } },
}

function diagnostic(code: string): CogniaDiagnostic {
  return { code, message: `said ${code}` } as unknown as CogniaDiagnostic
}

function deps(over: Partial<FusionChatTurnDeps> = {}): FusionChatTurnDeps {
  return {
    runTurn: jest.fn(async () => ({ kind: "succeeded" as const, answer, summary })),
    cancelRun: jest.fn(async () => {}),
    commitUserMessage: jest.fn(async () => {}),
    refusalDiagnostic: jest.fn(async (input) =>
      diagnostic(`${input.kind ?? "refused"}:${input.code}:${(input.reasons ?? []).join(",")}`)
    ),
    now: () => 100,
    ...over,
  }
}

const session = () => useChatStore.getState().sessions[SESSION]

beforeEach(() => {
  __resetFusionChatTurnsForTesting()
  useFusionProgressStore.setState({ bySession: {} })
  useChatStore.getState().replaceSessionMessages(SESSION, [user("compare the two")])
  useChatStore.getState().setSessionDiagnostic(SESSION, null)
  useChatStore.getState().setSessionStatus(SESSION, "streaming")
})

describe("fusionTranscriptOf", () => {
  it("keeps the text of each turn, drops the rest and the steer framing", () => {
    const messages: UIMessage[] = [
      { id: "s", role: "system", parts: [{ type: "text", text: "be brief" }] },
      user(`${STEER_PREFIX}and also this`),
      {
        id: "a",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking" } as never,
          { type: "text", text: "first" },
          { type: "text", text: "second" },
        ],
      },
      { id: "card", role: "assistant", parts: [{ type: "squad-run" } as never] },
      user("   "),
    ]
    expect(fusionTranscriptOf(messages)).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "and also this" },
      { role: "assistant", content: "first\n\nsecond" },
    ])
  })
})

describe("routerFusionSendDiagnostic", () => {
  it("explains a refusal and an unavailable Router + Fusion, and leaves other errors alone", async () => {
    const d = deps()
    expect(
      (
        await routerFusionSendDiagnostic(
          new RouterFusionRefusalError("FUSION_TEXT_ONLY", "images"),
          SESSION,
          d
        )
      )?.code
    ).toBe("refused:FUSION_TEXT_ONLY:")
    expect(
      (
        await routerFusionSendDiagnostic(
          new RouterFusionUnavailableError(
            new RouterFusionInfrastructureError("import_failed", "chunk")
          ),
          SESSION,
          d
        )
      )?.code
    ).toBe("failed:ROUTER_FUSION_UNAVAILABLE:import_failed")
    expect(await routerFusionSendDiagnostic(new Error("no candidates"), SESSION, d)).toBeNull()
  })
})

describe("runFusionChatTurn", () => {
  it("saves the message, runs the turn with progress, shows the answer and settles", async () => {
    const onSettled = jest.fn()
    const d = deps({
      runTurn: jest.fn(async (input) => {
        expect(fusionChatTurnActive(SESSION)).toBe(true)
        expect(useFusionProgressStore.getState().bySession[SESSION]).toMatchObject({
          runId: "run-1",
          mode: "panel",
          startedAt: 100,
          capMicrousd: 2_000_000,
        })
        input.onProgress?.(summary)
        expect(useFusionProgressStore.getState().bySession[SESSION]?.summary).toBe(summary)
        return { kind: "succeeded" as const, answer, summary }
      }),
    })
    const message = user("compare the two")
    const result = await runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [message],
        userMessage: message,
        workspaceRoot: "/work",
        settings: { id: "singleton" } as never,
        onSettled,
      },
      d
    )
    expect(result).toBe("completed")
    expect(d.commitUserMessage).toHaveBeenCalledWith(SESSION, message)
    expect(d.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION,
        stamp,
        messages: [{ role: "user", content: "compare the two" }],
        workspaceRoot: "/work",
        settings: { id: "singleton" },
      })
    )
    expect(session()?.messages.map((m) => m.id)).toEqual(["u1", "rf-run-1-answer"])
    expect(session()?.status).toBe("idle")
    expect(session()?.errorDiagnostic ?? null).toBeNull()
    expect(onSettled).toHaveBeenCalledWith("completed")
    expect(fusionChatTurnActive(SESSION)).toBe(false)
    expect(useFusionProgressStore.getState().bySession[SESSION]).toBeUndefined()
  })

  it("does not save a message that is already in the transcript, and runs even when saving fails", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => {})
    const skip = deps()
    await runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [user("x")],
        userMessage: null,
        workspaceRoot: null,
        settings: null,
      },
      skip
    )
    expect(skip.commitUserMessage).not.toHaveBeenCalled()

    const failing = deps({
      commitUserMessage: jest.fn(async () => Promise.reject(new Error("disk"))),
    })
    const result = await runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [user("x")],
        userMessage: user("x"),
        workspaceRoot: null,
        settings: null,
      },
      failing
    )
    expect(result).toBe("completed")
    expect(failing.runTurn).toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it("reports a failed run with its code and message", async () => {
    const onSettled = jest.fn()
    const d = deps({
      runTurn: jest.fn(async () => ({
        kind: "failed" as const,
        code: "VERIFICATION_FAILED",
        message: "checks failed",
        summary,
      })),
    })
    const result = await runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [],
        userMessage: null,
        workspaceRoot: null,
        settings: null,
        onSettled,
      },
      d
    )
    expect(result).toBe("failed")
    expect(session()?.errorDiagnostic?.code).toBe(
      "failed:VERIFICATION_FAILED:checks failed,run run-1"
    )
    expect(session()?.status).toBe("error")
    expect(onSettled).toHaveBeenCalledWith("failed")
  })

  it("reports a refused run, naming the run that holds the session", async () => {
    const d = deps({
      runTurn: jest.fn(async () => ({
        kind: "refused" as const,
        code: "SESSION_BUSY",
        activeRunId: "run-0",
      })),
    })
    expect(
      await runFusionChatTurn(
        {
          sessionId: SESSION,
          stamp,
          messages: [],
          userMessage: null,
          workspaceRoot: null,
          settings: null,
        },
        d
      )
    ).toBe("failed")
    expect(session()?.errorDiagnostic?.code).toBe("refused:SESSION_BUSY:run-0")
  })

  it("[ACC:ISO-03] reports an unavailable Router + Fusion as a failed fusion turn, a refusal as a refusal", async () => {
    const unavailable = deps({
      runTurn: jest.fn(async () => {
        throw new RouterFusionUnavailableError(
          new RouterFusionInfrastructureError("db_unavailable", "closed")
        )
      }),
    })
    await runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [],
        userMessage: null,
        workspaceRoot: null,
        settings: null,
      },
      unavailable
    )
    expect(session()?.errorDiagnostic?.code).toBe("failed:ROUTER_FUSION_UNAVAILABLE:db_unavailable")

    const refused = deps({
      runTurn: jest.fn(async () => {
        throw new RouterFusionRefusalError("ROUTER_FUSION_DISABLED", "off", {
          reasons: ["surface:chat"],
        })
      }),
    })
    await runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [],
        userMessage: null,
        workspaceRoot: null,
        settings: null,
      },
      refused
    )
    expect(session()?.errorDiagnostic?.code).toBe("refused:ROUTER_FUSION_DISABLED:surface:chat")

    const broken = deps({
      runTurn: jest.fn(async () => {
        throw new Error("unexpected")
      }),
    })
    expect(
      await runFusionChatTurn(
        {
          sessionId: SESSION,
          stamp,
          messages: [],
          userMessage: null,
          workspaceRoot: null,
          settings: null,
        },
        broken
      )
    ).toBe("failed")
    expect(session()?.errorDiagnostic?.message).toContain("unexpected")
    expect(session()?.status).toBe("error")
  })

  it("settles a run the person stopped as cancelled, leaving the session to the Stop", async () => {
    let release: (value: { kind: "cancelled"; summary: null }) => void = () => {}
    let signal: AbortSignal | undefined
    const onSettled = jest.fn()
    const d = deps({
      runTurn: jest.fn(
        (input) =>
          new Promise((resolve) => {
            signal = input.signal
            release = resolve
          })
      ),
    })
    const running = runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [],
        userMessage: null,
        workspaceRoot: null,
        settings: null,
        onSettled,
      },
      d
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The controller's Stop puts the session to idle, then stops the run.
    useChatStore.getState().setSessionStatus(SESSION, "idle")
    await stopFusionChatTurn(SESSION, null, { settled: true }, d)
    expect(d.cancelRun).toHaveBeenCalledWith(SESSION, { settings: null })
    expect(signal?.aborted).toBe(true)
    expect(useFusionProgressStore.getState().bySession[SESSION]).toBeUndefined()
    // A newer turn already streaming in the session is not touched by the late settle.
    useChatStore.getState().setSessionStatus(SESSION, "streaming")
    release({ kind: "cancelled", summary: null })
    expect(await running).toBe("cancelled")
    expect(session()?.status).toBe("streaming")
    expect(onSettled).toHaveBeenCalledWith("cancelled")
  })

  it("settles an interrupt-and-steer stop itself, keeping a late answer that is already durable", async () => {
    let release: (value: unknown) => void = () => {}
    const onSettled = jest.fn()
    const d = deps({
      runTurn: jest.fn(() => new Promise((resolve) => (release = resolve))) as never,
    })
    const running = runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [],
        userMessage: null,
        workspaceRoot: null,
        settings: null,
        onSettled,
      },
      d
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    await stopFusionChatTurn(SESSION, null, { settled: false }, d)
    expect(session()?.status).toBe("streaming")
    release({ kind: "succeeded", answer, summary })
    expect(await running).toBe("cancelled")
    expect(session()?.status).toBe("idle")
    expect(session()?.messages.map((m) => m.id)).toContain("rf-run-1-answer")
    expect(session()?.errorDiagnostic ?? null).toBeNull()
    expect(onSettled).toHaveBeenCalledWith("cancelled")
  })

  it("leaves the session to a newer turn when an older one settles late", async () => {
    const releases: Array<(value: unknown) => void> = []
    const d = deps({
      runTurn: jest.fn(() => new Promise((resolve) => releases.push(resolve))) as never,
    })
    const first = runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp,
        messages: [],
        userMessage: null,
        workspaceRoot: null,
        settings: null,
      },
      d
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = runFusionChatTurn(
      {
        sessionId: SESSION,
        stamp: { ...stamp, runId: "run-2" },
        messages: [],
        userMessage: null,
        workspaceRoot: null,
        settings: null,
      },
      d
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The older turn fails late: no diagnostic, no idle flip, no progress cleared.
    releases[0]?.({ kind: "failed", code: "VERIFICATION_FAILED", message: "late", summary: null })
    await first
    expect(session()?.status).toBe("streaming")
    expect(session()?.errorDiagnostic ?? null).toBeNull()
    expect(useFusionProgressStore.getState().bySession[SESSION]?.runId).toBe("run-2")
    expect(fusionChatTurnActive(SESSION)).toBe(true)

    releases[1]?.({ kind: "succeeded", answer, summary })
    expect(await second).toBe("completed")
    expect(session()?.status).toBe("idle")
    expect(fusionChatTurnActive(SESSION)).toBe(false)
  })

  it("stopping a session with no fusion turn does nothing", async () => {
    const d = deps()
    await stopFusionChatTurn(SESSION, null, { settled: true }, d)
    expect(d.cancelRun).not.toHaveBeenCalled()
  })
})
