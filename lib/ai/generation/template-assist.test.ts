/**
 * Template assist — prompt construction, the PII gate, and the merge rules
 * that keep model suggestions from inventing parameters the body never had.
 */

const generateObjectMock = jest.fn()
const generateTextMock = jest.fn()
jest.mock("ai", () => ({
  generateObject: (args: unknown) => generateObjectMock(args),
  generateText: (args: unknown) => generateTextMock(args),
}))
const piiMock = jest.fn((_s: string): boolean => true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: (s: string) => piiMock(s),
}))

import {
  applyParamSuggestions,
  generateTemplateDraft,
  improveTemplateBody,
  normalizeDraft,
  suggestTemplateParams,
  TemplateAssistPiiBlockedError,
} from "./template-assist"
import type { LanguageModel } from "ai"
import type { GenerationSeam } from "@cognia/provider-embedding/generation-seam"

const model: LanguageModel = "test-model"

beforeEach(() => {
  generateObjectMock.mockReset()
  generateTextMock.mockReset()
  piiMock.mockClear().mockReturnValue(true)
})

describe("generateTemplateDraft", () => {
  it("sends the intent as the user prompt and parses the schema result", async () => {
    generateObjectMock.mockResolvedValue({
      object: { name: "Weekly update", description: "status report", body: "Wins: {{wins}}" },
    })

    const draft = await generateTemplateDraft(model, "  a standup report  ")

    expect(generateObjectMock).toHaveBeenCalledTimes(1)
    const args = generateObjectMock.mock.calls[0][0]
    expect(args.prompt).toBe("Template request: a standup report")
    expect(args.system).toContain("{{parameter}}")
    expect(draft).toEqual({
      name: "Weekly update",
      description: "status report",
      body: "Wins: {{wins}}",
    })
  })

  it("throws the PII error when the intent trips the gate", async () => {
    piiMock.mockReturnValue(false)
    await expect(generateTemplateDraft(model, "sk-ant-…")).rejects.toBeInstanceOf(
      TemplateAssistPiiBlockedError
    )
    expect(generateObjectMock).not.toHaveBeenCalled()
  })
})

describe("improveTemplateBody", () => {
  it("returns the rewritten text and carries the instruction", async () => {
    generateTextMock.mockResolvedValue({ text: "  better {{module}} wording  " })

    const out = await improveTemplateBody(model, "review {{module}}", {
      instruction: "shorter",
    })

    const args = generateTextMock.mock.calls[0][0]
    expect(args.prompt).toBe("review {{module}}\n\nInstruction: shorter")
    expect(args.system).toContain("{{token}}")
    expect(out).toBe("better {{module}} wording")
  })

  it("omits the instruction block when none is given", async () => {
    generateTextMock.mockResolvedValue({ text: "x" })
    await improveTemplateBody(model, "review {{module}}")
    expect(generateTextMock.mock.calls[0][0].prompt).toBe("review {{module}}")
  })
})

describe("suggestTemplateParams + applyParamSuggestions", () => {
  it("annotates only the tokens the body actually has", async () => {
    generateObjectMock.mockResolvedValue({
      object: {
        suggestions: [
          { id: "module", label: "Module", required: true, kind: "string" },
          // The model hallucinated a token the body never declares — dropped.
          { id: "secret", label: "Secret", required: true, kind: "string" },
        ],
      },
    })

    const suggestions = await suggestTemplateParams(model, "review {{module}} on {{branch}}")
    const params = applyParamSuggestions("review {{module}} on {{branch}}", [], suggestions)

    expect(params.map((p) => p.id)).toEqual(["module", "branch"])
    expect(params[0].label).toBe("Module")
    // No suggestion arrived for branch — it keeps the derived default.
    expect(params[1]).toEqual({
      id: "branch",
      label: "branch",
      required: true,
      kind: "string",
    })
  })

  it("carries a suggested fill hint onto the declaration", () => {
    const params = applyParamSuggestions(
      "deploy {{target}}",
      [],
      [
        {
          id: "target",
          label: "Target",
          description: "  the service to deploy  ",
          required: true,
          kind: "string",
        },
      ]
    )
    expect(params[0].description).toBe("the service to deploy")
  })

  it("keeps a hand-written hint the suggestion left blank", () => {
    const existing = [
      {
        id: "module",
        label: "Module",
        description: "which module",
        required: true,
        kind: "string" as const,
      },
    ]
    const params = applyParamSuggestions("review {{module}}", existing, [
      { id: "module", label: "Module", required: true, kind: "string" },
    ])
    expect(params[0].description).toBe("which module")
  })

  it("demotes an enum suggestion with no options to string", async () => {
    const params = applyParamSuggestions(
      "pick {{choice}}",
      [],
      [{ id: "choice", label: "Choice", required: true, kind: "enum" }]
    )
    expect(params[0].kind).toBe("string")
  })

  it("keeps enum options and a valid resource kind", async () => {
    const params = applyParamSuggestions(
      "explain {{file}} as {{style}}",
      [],
      [
        { id: "file", label: "File", required: true, kind: "resource", resourceKind: "file" },
        {
          id: "style",
          label: "Style",
          required: true,
          kind: "enum",
          options: ["brief", "detailed"],
        },
      ]
    )
    expect(params[0]).toMatchObject({ kind: "resource", resourceKind: "file" })
    expect(params[1]).toMatchObject({ kind: "enum", options: ["brief", "detailed"] })
  })

  it("preserves a hand-written declaration the suggestion did not cover", async () => {
    const existing = [{ id: "module", label: "My label", required: false, kind: "string" as const }]
    const params = applyParamSuggestions("review {{module}}", existing, [
      { id: "module", label: "", required: true, kind: "string" },
    ])
    // Empty suggested label does not clobber the typed one; required does change.
    expect(params[0].label).toBe("My label")
    expect(params[0].required).toBe(true)
  })
})

describe("normalizeDraft", () => {
  it("trims, clamps the name, and drops an empty description", () => {
    expect(
      normalizeDraft({ name: `  ${"x".repeat(80)}  `, description: "   ", body: "b" })
    ).toEqual({ name: "x".repeat(60), body: "b" })
  })

  it("falls back to a name when the model returned whitespace", () => {
    expect(normalizeDraft({ name: "  ", body: "b" }).name).toBe("Untitled template")
  })
})

describe("template assist ledger seam", () => {
  it.each(["generate", "improve", "suggest"])(
    "reserves %s before sending and reports actual usage",
    async (stage) => {
      const usage = { inputTokens: 11, outputTokens: 7 }
      const providerMetadata = { provider: { cachedTokens: 2 } }
      const abortSignal = new AbortController().signal
      generateObjectMock.mockResolvedValue({
        object:
          stage === "generate"
            ? { name: "Draft", body: "{{module}}" }
            : { suggestions: [{ id: "module", label: "Module", required: true, kind: "string" }] },
        usage,
        providerMetadata,
      })
      generateTextMock.mockResolvedValue({ text: "Better {{module}}", usage, providerMetadata })
      const generate: GenerationSeam = async (request, send) => {
        expect(request).toMatchObject({ stage, modelId: "test-model", abortSignal })
        expect(generateObjectMock).not.toHaveBeenCalled()
        expect(generateTextMock).not.toHaveBeenCalled()
        const result = await send({ maxOutputTokens: 128, maxRetries: 0 })
        expect(result.usage).toBe(usage)
        expect(result.providerMetadata).toBe(providerMetadata)
        return result.text
      }
      const options = { generate, abortSignal }
      if (stage === "generate")
        await expect(generateTemplateDraft(model, "a draft", options)).resolves.toEqual({
          name: "Draft",
          body: "{{module}}",
        })
      else if (stage === "improve")
        await expect(improveTemplateBody(model, "{{module}}", options)).resolves.toBe(
          "Better {{module}}"
        )
      else
        await expect(suggestTemplateParams(model, "{{module}}", options)).resolves.toHaveLength(1)
      const call = stage === "improve" ? generateTextMock : generateObjectMock
      expect(call).toHaveBeenCalledTimes(1)
      expect(call.mock.calls[0][0]).toMatchObject({
        model,
        abortSignal,
        maxOutputTokens: 128,
        maxRetries: 0,
      })
      if (stage !== "improve") expect(call.mock.calls[0][0].schema).toBeDefined()
    }
  )

  it("rejects PII before reaching the ledger and never bypasses a ledger refusal", async () => {
    const generate = jest.fn(async () => {
      throw new Error("budget_refused")
    })
    piiMock.mockReturnValue(false)
    await expect(generateTemplateDraft(model, "private", { generate })).rejects.toBeInstanceOf(
      TemplateAssistPiiBlockedError
    )
    expect(generate).not.toHaveBeenCalled()
    piiMock.mockReturnValue(true)
    await expect(improveTemplateBody(model, "safe", { generate })).rejects.toThrow("budget_refused")
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(generateObjectMock).not.toHaveBeenCalled()
  })
})
