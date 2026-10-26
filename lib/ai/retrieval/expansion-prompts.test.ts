// Only the generation is faked, so the package's real template filling and the
// renderers bound here meet exactly as they do at runtime.
jest.mock("ai", () => ({ ...jest.requireActual("ai"), generateText: jest.fn() }))

import { generateText, type LanguageModel } from "ai"
import { generateHypotheticalAnswer, generateStepBackQuery } from "@cognia/rag/query-expansion"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
  type ActivePromptOverride,
} from "@/lib/prompts/snapshot"
import { validatePromptBody } from "@/lib/prompts/template"
import {
  loadExpansionPromptRenderers,
  RAG_HYDE_PROMPT,
  RAG_STEP_BACK_PROMPT,
} from "./expansion-prompts"

const mockedGenerateText = generateText as jest.Mock
const model = { modelId: "m-1" } as unknown as LanguageModel

function sentPrompts(): string[] {
  return mockedGenerateText.mock.calls.map((call) => (call[0] as { prompt: string }).prompt)
}

function install(rows: Array<Omit<ActivePromptOverride, "bindingId" | "contractVersion">>): void {
  __setPromptOverrideSnapshotForTests(
    buildPromptOverrideSnapshot(
      "test-db",
      rows.map((row) => ({
        ...row,
        bindingId: `pob-${row.revisionId}`,
        contractVersion: 1,
      }))
    )
  )
}

beforeEach(() => {
  mockedGenerateText.mockReset()
  mockedGenerateText.mockResolvedValue({ text: "out" })
})

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

describe("expansion prompt definitions", () => {
  it("ship the package templates and validate against their own contracts", () => {
    for (const def of [RAG_HYDE_PROMPT, RAG_STEP_BACK_PROMPT]) {
      expect(validatePromptBody(def, def.defaultBody)).toEqual([])
      expect(def.consumers).toEqual(["lib/ai/retrieval/expansion-prompts.ts"])
    }
  })
})

describe("loadExpansionPromptRenderers", () => {
  it("renders exactly what the package sends by default", async () => {
    install([])
    const renderers = await loadExpansionPromptRenderers({})
    await generateHypotheticalAnswer("what is x?", model)
    await generateHypotheticalAnswer("what is x?", model, { renderPrompt: renderers.hyde })
    await generateStepBackQuery("what is x?", model)
    await generateStepBackQuery("what is x?", model, { renderPrompt: renderers.stepBack })
    const [hyde, hydeBound, stepBack, stepBackBound] = sentPrompts()
    expect(hydeBound).toBe(hyde)
    expect(stepBackBound).toBe(stepBack)
  })

  it("sends a published account override with the call's values", async () => {
    install([
      {
        promptId: RAG_HYDE_PROMPT.id,
        scope: "account",
        targetId: "",
        revisionId: "por-hyde-1",
        body: "Draft a {{maxLength}}-char answer to: {{query}}",
      },
    ])
    const renderers = await loadExpansionPromptRenderers({})
    await generateHypotheticalAnswer("what is x?", model, { renderPrompt: renderers.hyde })
    expect(sentPrompts()).toEqual(["Draft a 300-char answer to: what is x?"])
  })

  it("applies a workspace override to that workspace's retrieval only", async () => {
    install([
      {
        promptId: RAG_STEP_BACK_PROMPT.id,
        scope: "workspace",
        targetId: "ws-1",
        revisionId: "por-step-back-1",
        body: "Broader question behind: {{query}}",
      },
    ])
    const inWorkspace = await loadExpansionPromptRenderers({ workspaceId: "ws-1" })
    const elsewhere = await loadExpansionPromptRenderers({ workspaceId: "ws-2" })
    expect(inWorkspace.stepBack({ query: "q" })).toBe("Broader question behind: q")
    expect(elsewhere.stepBack({ query: "q" })).toContain('Specific question: "q"')
  })

  it("applies an agent override to that twin's retrieval only", async () => {
    install([
      {
        promptId: RAG_HYDE_PROMPT.id,
        scope: "agent",
        targetId: "twin-1",
        revisionId: "por-hyde-agent-1",
        body: "In my own voice, answer {{query}}",
      },
    ])
    const twin = await loadExpansionPromptRenderers({ agentId: "twin-1" })
    const other = await loadExpansionPromptRenderers({ agentId: "twin-2" })
    const values = { domainContext: "", maxLength: "300", query: "q" }
    expect(twin.hyde(values)).toBe("In my own voice, answer q")
    expect(other.hyde(values)).toContain('Question: "q"')
  })
})
