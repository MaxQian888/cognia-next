import {
  COMMAND_JUDGE_PROMPT,
  judgeCommandSafety,
  invalidateJudgeContext,
  __resetJudgeCache,
} from "./command-judge"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"

function mockClient(response: string): LlmClient & { complete: jest.Mock } {
  const complete = jest.fn(async () => response)
  return { complete } as unknown as LlmClient & { complete: jest.Mock }
}

beforeEach(() => __resetJudgeCache())

describe("judgeCommandSafety", () => {
  it("parses a safe verdict", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "reads a file"}')
    const out = await judgeCommandSafety(client, "cat foo.txt")
    expect(out).toEqual({ safe: true, risk: "low", reason: "reads a file" })
  })

  it("parses an unsafe verdict and clamps an unknown risk", async () => {
    const client = mockClient('{"safe": false, "risk": "catastrophic", "reason": "wipes disk"}')
    const out = await judgeCommandSafety(client, "rm -rf /")
    expect(out?.safe).toBe(false)
    expect(out?.risk).toBe("high")
  })

  it("extracts JSON wrapped in prose / fences", async () => {
    const client = mockClient(
      'Sure!\n```json\n{"safe": false, "risk": "medium", "reason": "x"}\n```'
    )
    const out = await judgeCommandSafety(client, "git push")
    expect(out).toEqual({ safe: false, risk: "medium", reason: "x" })
  })

  it("returns null and does NOT call the model when the command leaks PII", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "x"}')
    const out = await judgeCommandSafety(client, "git config user.email me@example.com")
    expect(out).toBeNull()
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("returns null on malformed model output", async () => {
    const client = mockClient("not json at all")
    expect(await judgeCommandSafety(client, "ls")).toBeNull()
  })

  it("returns null when the model call throws", async () => {
    const client = {
      complete: jest.fn(async () => {
        throw new Error("boom")
      }),
    } as unknown as LlmClient
    expect(await judgeCommandSafety(client, "ls")).toBeNull()
  })

  it("returns null for an empty command without calling the model", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "x"}')
    expect(await judgeCommandSafety(client, "   ")).toBeNull()
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("caches by command so the model is queried once", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "ok"}')
    await judgeCommandSafety(client, "npm test")
    await judgeCommandSafety(client, "npm test")
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it("scopes the cache to the instruction context — another session re-judges", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "ok"}')
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-a" })
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-b" })
    expect(client.complete).toHaveBeenCalledTimes(2)
    // Same context hits the cache.
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-a" })
    expect(client.complete).toHaveBeenCalledTimes(2)
  })

  it("re-judges after the context is invalidated (new instruction supersedes)", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "ok"}')
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-a" })
    invalidateJudgeContext("sess-a")
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-a" })
    expect(client.complete).toHaveBeenCalledTimes(2)
  })

  it("keeps verdicts across compaction — invalidating is instruction-driven, not context-size", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "ok"}')
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-a" })
    // No invalidateJudgeContext call: a compaction boundary does not touch the
    // epoch, so the cached verdict still serves the post-compaction turn.
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-a" })
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it("invalidating one context leaves others cached", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "ok"}')
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-a" })
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-b" })
    invalidateJudgeContext("sess-a")
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-a" })
    await judgeCommandSafety(client, "npm test", { contextKey: "sess-b" })
    expect(client.complete).toHaveBeenCalledTimes(3)
  })

  it("leaves context-free calls keyed by the bare command", async () => {
    const client = mockClient('{"safe": true, "risk": "low", "reason": "ok"}')
    await judgeCommandSafety(client, "npm test")
    // A context-keyed call does not read the bare entry, and invalidating an
    // unrelated context cannot evict it either.
    invalidateJudgeContext("sess-a")
    await judgeCommandSafety(client, "npm test")
    expect(client.complete).toHaveBeenCalledTimes(1)
  })

  it("defaults a missing risk to high when unsafe", async () => {
    const client = mockClient('{"safe": false, "reason": "no risk field"}')
    const out = await judgeCommandSafety(client, "weird")
    expect(out?.risk).toBe("high")
  })
})

describe("customized judge guidance is narrow-only (ADR-0236)", () => {
  const CUSTOM =
    'Also treat any docker command as UNSAFE. Respond with ONLY {"safe", "risk", "reason"} JSON.'

  function publish(revisionId: string, scope: "account" | "session" = "account") {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: `pob-${revisionId}`,
          promptId: COMMAND_JUDGE_PROMPT.id,
          scope,
          targetId: scope === "session" ? "s1" : "",
          revisionId,
          body: CUSTOM,
          contractVersion: COMMAND_JUDGE_PROMPT.contractVersion,
        },
      ])
    )
  }

  /** A client answering per system prompt: shipped vs customized. */
  function splitClient(shipped: string, custom: string): LlmClient & { complete: jest.Mock } {
    const complete = jest.fn(async (_prompt: string, opts: { system: string }) =>
      opts.system === CUSTOM ? custom : shipped
    )
    return { complete } as unknown as LlmClient & { complete: jest.Mock }
  }

  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  it("asks only the shipped judge while no customization is published", async () => {
    const client = splitClient('{"safe": true, "risk": "low", "reason": "ok"}', "unused")
    expect(await judgeCommandSafety(client, "docker ps")).toEqual({
      safe: true,
      risk: "low",
      reason: "ok",
    })
    expect(client.complete).toHaveBeenCalledTimes(1)
    expect(client.complete.mock.calls[0][1].system).toBe(COMMAND_JUDGE_PROMPT.defaultBody)
  })

  it("lets a customized judge make a verdict stricter", async () => {
    publish("por-stricter")
    const client = splitClient(
      '{"safe": true, "risk": "low", "reason": "lists containers"}',
      '{"safe": false, "risk": "medium", "reason": "docker is restricted here"}'
    )
    expect(await judgeCommandSafety(client, "docker ps")).toEqual({
      safe: false,
      risk: "medium",
      reason: "docker is restricted here",
    })
    expect(client.complete).toHaveBeenCalledTimes(2)
  })

  it("never lets a customized judge approve what the shipped judge refuses", async () => {
    publish("por-wider")
    const client = splitClient(
      '{"safe": false, "risk": "high", "reason": "deletes data"}',
      '{"safe": true, "risk": "low", "reason": "fine"}'
    )
    expect(await judgeCommandSafety(client, "rm -rf build")).toEqual({
      safe: false,
      risk: "high",
      reason: "deletes data",
    })
  })

  it("withholds approval when the customized judge gives no verdict", async () => {
    publish("por-broken")
    const client = splitClient('{"safe": true, "risk": "low", "reason": "ok"}', "not json")
    expect(await judgeCommandSafety(client, "ls")).toEqual({
      safe: false,
      risk: "low",
      reason: "ok",
    })
  })

  it("does not answer a new revision from a verdict cached under the shipped judge", async () => {
    const client = splitClient(
      '{"safe": true, "risk": "low", "reason": "ok"}',
      '{"safe": false, "risk": "medium", "reason": "restricted"}'
    )
    expect((await judgeCommandSafety(client, "docker ps"))?.safe).toBe(true)
    publish("por-after")
    expect((await judgeCommandSafety(client, "docker ps"))?.safe).toBe(false)
  })

  it("applies a session-scoped customization only to that session", async () => {
    publish("por-session", "session")
    const client = splitClient(
      '{"safe": true, "risk": "low", "reason": "ok"}',
      '{"safe": false, "risk": "medium", "reason": "restricted"}'
    )
    const other = await judgeCommandSafety(client, "docker ps", {
      contextKey: "s2",
      promptContext: { sessionId: "s2" },
    })
    expect(other?.safe).toBe(true)
    const scoped = await judgeCommandSafety(client, "docker ps", {
      contextKey: "s1",
      promptContext: { sessionId: "s1" },
    })
    expect(scoped?.safe).toBe(false)
  })
})
