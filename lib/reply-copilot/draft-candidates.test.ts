import type { LlmClient } from "@/lib/twin/distill/llm"
import type { CopilotTranscript } from "./build-state"
import {
  DRAFT_SYSTEM_PROMPT,
  buildDraftPrompt,
  draftCandidates,
  parseCandidates,
} from "./draft-candidates"

const transcript: CopilotTranscript = {
  turns: [
    { from: "other", text: "明天的会\n你来吗" },
    { from: "me", text: "来" },
    { from: "other", text: "那你把材料发我 13812345678" },
  ],
  latestFrom: "other",
  latestOtherSender: null,
  isGroup: false,
}

function client(reply: string) {
  const complete = jest.fn(async (_prompt: string, _options?: unknown) => reply)
  return { complete, client: { complete } as unknown as LlmClient }
}

describe("buildDraftPrompt", () => {
  it("quotes background, relationship, turns and instructions as context", () => {
    const prompt = buildDraftPrompt({
      transcript,
      relationship: "manager",
      background: "About this contact: prefers email",
      instructions: "say Friday",
    })
    expect(prompt).toContain("Background:\nAbout this contact: prefers email")
    expect(prompt).toContain("Relationship: manager")
    expect(prompt).toContain("Them: 明天的会 你来吗")
    expect(prompt).toContain("Me: 来")
    expect(prompt).toContain("What I want to say: say Friday")
  })
})

describe("buildDraftPrompt with unattributed turns", () => {
  it("labels unknown senders and tells the model not to guess", () => {
    const prompt = buildDraftPrompt({
      transcript: {
        ...transcript,
        turns: [...transcript.turns, { from: "unknown", text: "几点？" }],
        latestFrom: "unknown",
      },
      relationship: "",
      background: "",
      instructions: "",
    })
    expect(prompt).toContain("Unknown: 几点？")
    expect(prompt).toContain("do not assume who wrote them")
  })

  it("adds no attribution note when every sender is known", () => {
    const prompt = buildDraftPrompt({
      transcript,
      relationship: "",
      background: "",
      instructions: "",
    })
    expect(prompt).not.toContain("could not be attributed")
  })
})

describe("parseCandidates", () => {
  it("reads a JSON array, trims quotes, de-duplicates and caps at three", () => {
    expect(parseCandidates('ok:\n["“好的”", "好的", "明早发你", "稍等", "extra"]')).toEqual([
      "好的",
      "明早发你",
      "稍等",
    ])
  })

  it("falls back to list lines when the model skips JSON", () => {
    expect(parseCandidates("1. 好的\n2) 我明早发你\n- 稍等")).toEqual([
      "好的",
      "我明早发你",
      "稍等",
    ])
    expect(parseCandidates("")).toEqual([])
  })
})

describe("draftCandidates", () => {
  it("sends a redacted prompt and restores placeholders in the replies", async () => {
    const { complete, client: c } = client('["发你了 <PHONE_001>", "明早九点前发", "好"]')
    const result = await draftCandidates({
      transcript,
      relationship: "",
      background: "",
      instructions: "",
      client: c,
    })
    const [prompt, options] = complete.mock.calls[0]
    expect(prompt).not.toContain("13812345678")
    expect(options).toMatchObject({ system: DRAFT_SYSTEM_PROMPT })
    expect(result).toEqual({
      kind: "drafts",
      candidates: ["发你了 13812345678", "明早九点前发", "好"],
    })
  })

  it("skips when there is nothing to reply to or the model returns nothing", async () => {
    const empty = await draftCandidates({
      transcript: { ...transcript, turns: [] },
      relationship: "",
      background: "",
      instructions: " ",
      client: client("x").client,
    })
    expect(empty).toEqual({ kind: "skipped", reason: "empty" })
    const blank = await draftCandidates({
      transcript,
      relationship: "",
      background: "",
      instructions: "",
      client: client("   ").client,
    })
    expect(blank).toEqual({ kind: "skipped", reason: "no-output" })
  })

  it("honors an aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      draftCandidates({
        transcript,
        relationship: "",
        background: "",
        instructions: "",
        client: client("[]").client,
        signal: controller.signal,
      })
    ).rejects.toThrow()
  })
})
