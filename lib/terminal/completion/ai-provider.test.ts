import { __resetAiCompletionCacheForTesting, createAiCompletionProvider } from "./ai-provider"
import type { TerminalCompletionContext } from "./types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { TERMINAL_COMPLETION_PROMPT } from "./prompt"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"

function ctx(
  input: string,
  over: Partial<TerminalCompletionContext> = {}
): TerminalCompletionContext {
  return {
    sessionId: "s1",
    shell: "bash",
    shellPath: "/bin/bash",
    cwd: "/home/me",
    input,
    cursor: input.length,
    recentCommands: [],
    platform: "linux",
    ...over,
  }
}

function fakeClient(reply: string): LlmClient & { complete: jest.Mock } {
  const complete = jest.fn(async () => reply)
  return { complete } as unknown as LlmClient & { complete: jest.Mock }
}

const signal = new AbortController().signal

beforeEach(() => __resetAiCompletionCacheForTesting())

describe("createAiCompletionProvider", () => {
  it("returns a sanitized AI suggestion", async () => {
    const client = fakeClient("git status")
    const p = createAiCompletionProvider({ getClient: () => client })
    const out = await p.getCompletions(ctx("git "), signal)
    expect(out).toEqual([
      expect.objectContaining({ text: "git status", source: "ai", providerId: "builtin:ai" }),
    ])
  })

  it("returns [] when no client is configured (graceful degradation)", async () => {
    const p = createAiCompletionProvider({ getClient: () => null })
    expect(await p.getCompletions(ctx("git "), signal)).toEqual([])
  })

  it("does not call the model when the context contains PII", async () => {
    const client = fakeClient("anything")
    const p = createAiCompletionProvider({ getClient: () => client })
    // sk- API key in the partial input trips the real hasNoLeakingPii gate.
    const out = await p.getCompletions(ctx("export KEY=sk-ABCD1234efgh5678IJKL90mnop"), signal)
    expect(out).toEqual([])
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("caches by (shell, cwd, input) so identical queries hit the model once", async () => {
    const client = fakeClient("git status")
    const p = createAiCompletionProvider({ getClient: () => client })
    await p.getCompletions(ctx("git "), signal)
    await p.getCompletions(ctx("git "), signal)
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it("caches a null result so a dud prefix is not retried", async () => {
    const client = fakeClient("git ") // sanitizes to null
    const p = createAiCompletionProvider({ getClient: () => client })
    expect(await p.getCompletions(ctx("git "), signal)).toEqual([])
    expect(await p.getCompletions(ctx("git "), signal)).toEqual([])
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it("returns [] when the signal aborts before the model resolves", async () => {
    const ac = new AbortController()
    const client: LlmClient = {
      complete: async () => {
        ac.abort()
        return "git status"
      },
    }
    const p = createAiCompletionProvider({ getClient: () => client })
    expect(await p.getCompletions(ctx("git "), ac.signal)).toEqual([])
  })

  it("swallows model errors and returns []", async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new Error("rate limited")
      },
    }
    const p = createAiCompletionProvider({ getClient: () => client })
    expect(await p.getCompletions(ctx("git "), signal)).toEqual([])
  })

  it("expires cache entries past the TTL", async () => {
    let t = 1000
    const client = fakeClient("git status")
    const p = createAiCompletionProvider({ getClient: () => client, now: () => t })
    await p.getCompletions(ctx("git "), signal)
    t += 60_000 // beyond TTL
    await p.getCompletions(ctx("git "), signal)
    expect(client.complete).toHaveBeenCalledTimes(2)
  })
})

describe("customized terminal completion prompt (ADR-0236)", () => {
  afterEach(() => __setPromptOverrideSnapshotForTests(null))

  it("sends the workspace override and never answers from a result cached under other text", async () => {
    const client = fakeClient("git status")
    const provider = createAiCompletionProvider({ getClient: () => client, isPiiSafe: () => true })
    await provider.getCompletions(ctx("git s", { projectId: "ws-1" }), signal)
    expect(client.complete.mock.calls[0][1].system).toBe(TERMINAL_COMPLETION_PROMPT.defaultBody)

    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: TERMINAL_COMPLETION_PROMPT.id,
          scope: "workspace",
          targetId: "ws-1",
          revisionId: "por",
          body: "Prefer the project's make targets.",
          contractVersion: TERMINAL_COMPLETION_PROMPT.contractVersion,
        },
      ])
    )
    await provider.getCompletions(ctx("git s", { projectId: "ws-1" }), signal)
    expect(client.complete).toHaveBeenCalledTimes(2)
    expect(client.complete.mock.calls[1][1].system).toBe("Prefer the project's make targets.")
  })
})
