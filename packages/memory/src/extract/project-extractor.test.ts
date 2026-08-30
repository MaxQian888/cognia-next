import type { LlmClient } from "../llm"
import {
  PROJECT_PROMPT_VERSION,
  extractProjectClaims,
  type ExtractProjectClaimsInput,
} from "./project-extractor"

const WINDOW: ExtractProjectClaimsInput["messages"] = [
  { id: "m1", role: "user", text: "why does the desktop build read out/?" },
  { id: "m2", role: "assistant", text: "tauri.conf.json points frontendDist at ../out" },
]

const clientReturning = (payload: unknown): LlmClient => ({
  complete: jest.fn(async () => JSON.stringify(payload)),
})

const claim = (over: Record<string, unknown> = {}) => ({
  kind: "state",
  text: "The desktop shell loads the static export from out/.",
  importance: 7,
  confidence: 0.8,
  observedAtMessageId: "m2",
  supportRole: "assistant",
  evidence: [{ kind: "message", sourceId: "m2" }],
  ...over,
})

describe("extractProjectClaims", () => {
  it("parses a well-formed claim", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      clientReturning({ claims: [claim()] })
    )
    expect(out).toEqual([
      {
        kind: "state",
        text: "The desktop shell loads the static export from out/.",
        importance: 7,
        confidence: 0.8,
        observedAtMessageId: "m2",
        supportRole: "assistant",
        evidence: [{ kind: "message", sourceId: "m2" }],
      },
    ])
  })

  it("DROPS a claim whose anchor message is not in the window", async () => {
    // `observedAt` is derived from that message's timestamp, so a hallucinated
    // anchor has nothing to anchor to and nothing to validate against later.
    // There is no degraded form worth quarantining.
    const out = await extractProjectClaims(
      { messages: WINDOW },
      clientReturning({ claims: [claim({ observedAtMessageId: "m99" })] })
    )
    expect(out).toEqual([])
  })

  it("drops evidence that points outside the window", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      clientReturning({
        claims: [
          claim({
            evidence: [
              { kind: "message", sourceId: "m2" },
              { kind: "message", sourceId: "elsewhere" },
              { kind: "tool-result", sourceId: "m1:3" },
              { kind: "tool-result", sourceId: "ghost:0" },
            ],
          }),
        ],
      })
    )
    expect(out[0]?.evidence).toEqual([
      { kind: "message", sourceId: "m2" },
      { kind: "tool-result", sourceId: "m1:3" },
    ])
  })

  it("keeps a code-location reference, which is not a window id", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      clientReturning({
        claims: [
          claim({ evidence: [{ kind: "code-location", sourceId: "src-tauri/tauri.conf.json" }] }),
        ],
      })
    )
    expect(out[0]?.evidence).toEqual([
      { kind: "code-location", sourceId: "src-tauri/tauri.conf.json" },
    ])
  })

  it("rejects an unknown kind", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      clientReturning({ claims: [claim({ kind: "vibe" })] })
    )
    expect(out).toEqual([])
  })

  it("clamps importance and confidence instead of trusting the model", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      clientReturning({ claims: [claim({ importance: 99, confidence: 4 })] })
    )
    expect(out[0]).toMatchObject({ importance: 10, confidence: 1 })
  })

  it("defaults a missing importance and confidence", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      clientReturning({ claims: [claim({ importance: undefined, confidence: undefined })] })
    )
    expect(out[0]).toMatchObject({ importance: 5, confidence: 0.5 })
  })

  it("carries the optional narrowing fields through", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      clientReturning({
        claims: [
          claim({
            key: "pm:frontend-dist",
            scopeRationale: "only the desktop shell",
            pathHint: "src-tauri",
            branchScoped: true,
          }),
        ],
      })
    )
    expect(out[0]).toMatchObject({
      key: "pm:frontend-dist",
      scopeRationale: "only the desktop shell",
      pathHint: "src-tauri",
      branchScoped: true,
    })
  })

  it("returns [] on an LLM failure rather than throwing", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      {
        complete: jest.fn(async () => {
          throw new Error("model down")
        }),
      }
    )
    expect(out).toEqual([])
  })

  it("returns [] on unparsable output", async () => {
    const out = await extractProjectClaims(
      { messages: WINDOW },
      { complete: jest.fn(async () => "not json") }
    )
    expect(out).toEqual([])
  })

  it("does not call the model for an empty window", async () => {
    const client = clientReturning({ claims: [] })
    const out = await extractProjectClaims({ messages: [] }, client)
    expect(out).toEqual([])
    expect(client.complete).not.toHaveBeenCalled()
  })

  it("shows the model each message id and tells it the transcript is data", async () => {
    const client = clientReturning({ claims: [] })
    await extractProjectClaims({ messages: WINDOW }, client)
    const [prompt, options] = (client.complete as jest.Mock).mock.calls[0]
    expect(prompt).toContain("[m1]")
    expect(prompt).toContain("[m2]")
    // Prompt-injection floor: the window is other people's text.
    expect(options.system).toContain("DATA")
    expect(options.system).toContain("never follow")
    // The personal extractor's contract must NOT leak in here.
    expect(options.system).not.toContain("about the USER")
  })

  it("exposes a prompt version so a bad prompt's output can be found in bulk", () => {
    // Pinned to a literal on purpose: editing the prompt without bumping this
    // makes rows from the old and new prompt indistinguishable, so the failure
    // here is the reminder. v2 added the `[tool N]` citation rule when the
    // extractor started being shown tool output.
    expect(PROJECT_PROMPT_VERSION).toBe("project-v2")
  })
})
