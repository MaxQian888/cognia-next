import { readFileSync } from "node:fs"
import path from "node:path"

import {
  computeSequenceDigest,
  validateCanonicalSession,
  type CanonicalSession,
  type CanonicalTurn,
} from "@cognia/agent-config-types/canonical-session"

import type { ImportedConversation } from "@/lib/data/importers/types"
import { buildReplayPrompt, conversationToCanonical } from "./codec-types"

function conversation(): ImportedConversation {
  return {
    session: {
      id: "s-1",
      title: "Fix the bug",
      createdAt: 1_753_000_000_000,
      updatedAt: 1_753_000_100_000,
      sdkSessionId: "sdk-native-1",
    } as ImportedConversation["session"],
    messages: [
      { id: "m1", sessionId: "s-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "m2",
        sessionId: "s-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "private thinking" },
          { type: "text", text: "let me check" },
          {
            type: "tool-Read",
            toolCallId: "call-1",
            input: { file_path: "/x" },
            output: "file body",
            state: "output-available",
          },
          { type: "text", text: " — done" },
        ],
      },
      {
        id: "m3",
        sessionId: "s-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolName: "Bash",
            toolCallId: "call-2",
            input: { command: "ls" },
            errorText: "boom",
            state: "output-error",
          },
          { type: "step-start" },
        ],
      },
    ] as unknown as ImportedConversation["messages"],
  }
}

describe("conversationToCanonical", () => {
  it("produces a VALID canonical session with text+tool turns and the runtime binding", () => {
    const { session } = conversationToCanonical(conversation(), {
      sourceRuntime: "claude-code",
      importFidelity: "structured",
    })
    expect(validateCanonicalSession(session)).toEqual([])
    expect(session.header).toMatchObject({
      canonicalSessionId: "canon:claude-code:s-1",
      sourceRuntime: "claude-code",
      runtimeBinding: { nativeSessionId: "sdk-native-1" },
      importFidelity: "structured",
      turnCount: 3,
    })
    expect(session.turns[1]).toMatchObject({
      role: "assistant",
      text: "let me check — done",
      toolCalls: [
        {
          callId: "call-1",
          toolName: "Read",
          input: { file_path: "/x" },
          resultText: "file body",
        },
      ],
    })
    expect(session.turns[2].toolCalls).toEqual([
      expect.objectContaining({
        callId: "call-2",
        toolName: "Bash",
        resultText: "boom",
        isError: true,
      }),
    ])
  })

  it("reports every drop honestly: reasoning, unknown parts, nested transcripts", () => {
    const withNested = conversation()
    withNested.nested = [conversation()]
    const { loss } = conversationToCanonical(withNested, {
      sourceRuntime: "claude-code",
      importFidelity: "structured",
    })
    expect(loss.fidelity).toBe("structured")
    expect(loss.losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "turns[1].reasoning", kind: "dropped" }),
        expect.objectContaining({ path: "turns[2].parts[1]", detail: "step-start" }),
        expect.objectContaining({ path: "nested", kind: "summarized" }),
      ])
    )
  })

  it("same conversation ⇒ same sequence digest (deterministic across runs)", () => {
    const a = conversationToCanonical(conversation(), {
      sourceRuntime: "codex",
      importFidelity: "structured",
    })
    const b = conversationToCanonical(conversation(), {
      sourceRuntime: "codex",
      importFidelity: "structured",
    })
    expect(a.session.header.sequenceDigest).toBe(b.session.header.sequenceDigest)
  })
})

describe("conversion edge branches", () => {
  it("handles system roles, object outputs, absent title/binding and metadata timestamps", () => {
    const { session } = conversationToCanonical(
      {
        session: { id: "s-2", createdAt: 1, updatedAt: 2 } as never,
        messages: [
          {
            id: "m1",
            sessionId: "s-2",
            role: "system",
            parts: [{ type: "text", text: "sys" }],
            metadata: { createdAt: "2026-07-24T00:00:00.000Z" },
          },
          {
            id: "",
            sessionId: "s-2",
            role: "assistant",
            parts: [
              {
                type: "dynamic-tool",
                toolName: "Bash",
                toolCallId: "c9",
                input: "not-an-object",
                output: { nested: true },
              },
            ],
          },
        ] as never,
      },
      { sourceRuntime: "codex", importFidelity: "structured" }
    )
    expect(session.header.title).toBeUndefined()
    expect(session.header.runtimeBinding).toBeUndefined()
    expect(session.turns[0]).toMatchObject({ role: "system", at: "2026-07-24T00:00:00.000Z" })
    // Empty message id gets a positional turn id; object output stringifies.
    expect(session.turns[1].turnId).toBe("turn-1")
    expect(session.turns[1].toolCalls?.[0]).toMatchObject({
      toolName: "Bash",
      resultText: '{"nested":true}',
    })
    expect(session.turns[1].toolCalls?.[0].input).toBeUndefined()
    // A prompt for an untitled session omits the quoted-title clause.
    expect(buildReplayPrompt(session)).toContain("imported from codex. Transcript so far:")
  })
})

describe("conversion fallback branches", () => {
  it("falls back for anonymous tools, circular outputs and missing timestamps", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const { session } = conversationToCanonical(
      {
        session: { id: "s-3" } as never,
        messages: [
          {
            id: "m1",
            sessionId: "s-3",
            role: "assistant",
            parts: [
              // dynamic-tool without toolName/toolCallId → "tool" + positional id.
              { type: "dynamic-tool", output: circular },
              // output-error state without errorText still flags isError.
              { type: "tool-Write", toolCallId: "cW", state: "output-error" },
            ],
          },
        ] as never,
      },
      { sourceRuntime: "codex", importFidelity: "structured" }
    )
    const calls = session.turns[0].toolCalls!
    expect(calls[0]).toMatchObject({ toolName: "tool", callId: "call-0" })
    expect(calls[0].resultText).toBe("[object Object]") // JSON.stringify threw → String fallback
    expect(calls[1]).toMatchObject({ toolName: "Write", callId: "cW", isError: true })
    // Missing createdAt/updatedAt fall back to "now" without throwing.
    expect(Date.parse(session.header.createdAt)).toBeGreaterThan(0)
  })
})

describe("buildReplayPrompt", () => {
  it("frames the transcript for a NEW session without any runtime-private format", () => {
    const { session } = conversationToCanonical(conversation(), {
      sourceRuntime: "claude-code",
      importFidelity: "structured",
    })
    const prompt = buildReplayPrompt(session)
    expect(prompt).toContain('imported from claude-code ("Fix the bug")')
    expect(prompt).toContain("user: hello")
    expect(prompt).toContain("assistant: let me check — done [tools: Read]")
    expect(prompt).toContain("Continue the conversation from this point.")
    // No private JSONL / sdk ids leak into the replay prompt.
    expect(prompt).not.toContain("sdk-native-1")
  })
})

describe("materialization fixture parity (conformance bridge)", () => {
  it("pins the replay prompt BYTE-EXACT against the conformance fixture", () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(process.cwd(), "tests/conformance/fixtures/session-materialize-replay.json"),
        "utf8"
      )
    ) as {
      sourceRuntime: string
      title: string
      turns: CanonicalTurn[]
      replayPrompt: string
    }
    const session: CanonicalSession = {
      header: {
        canonicalVersion: 1,
        canonicalSessionId: "canon:fixture:materialize",
        sourceRuntime: fixture.sourceRuntime,
        title: fixture.title,
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        turnCount: fixture.turns.length,
        importFidelity: "structured",
        sequenceDigest: computeSequenceDigest(fixture.turns),
      },
      turns: fixture.turns,
    }
    expect(validateCanonicalSession(session)).toEqual([])
    // The conformance case drives this exact string through the real sidecar;
    // if buildReplayPrompt's format changes, BOTH sides fail together.
    expect(buildReplayPrompt(session)).toBe(fixture.replayPrompt)
  })
})
