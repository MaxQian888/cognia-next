// AI assistance for authoring chat templates.
//
// Three operations, one module — the same split `canvas-actions.ts` made for
// the Canvas workbench: prompts and the PII gate live HERE, not at the call
// sites, so a second consumer (a plugin, a slash action) cannot forget the
// redaction check.
//
//   - generateTemplateDraft:  "a standup report" -> name + body with {{slots}}
//   - improveTemplateBody:    rewrite a body, every {{token}} kept verbatim
//   - suggestTemplateParams:  label/kind/options for the tokens a body has
//
// What the model is NEVER trusted with: which parameters exist. That is the
// body's job — `deriveParams` walks the text and suggestions only annotate
// the declarations it produced, so a model inventing a `{{secret}}` slot
// cannot create a parameter the message does not ask for.

import { generateObject, generateText, type LanguageModel } from "ai"
import { z } from "zod"
import {
  generateThroughSeam,
  modelIdOf,
  type GenerationSeam,
} from "@cognia/provider-embedding/generation-seam"
import { hasNoLeakingPii } from "@cognia/redact"
import { deriveParams, paramKindChange, type ChatTemplateParam } from "@/lib/chat/template/template"
import { RESOURCE_PARAM_KINDS, type ResourceParamKind } from "@/lib/chat/template/resource-kinds"
import { resolvePromptAsync } from "@/lib/prompts/resolve"
import {
  definePrompt,
  type PromptDefinitionInput,
  type PromptDefinitionV1,
} from "@/lib/prompts/types"

/** Thrown when the prompt trips the redaction gate — a fixable user problem, not a provider failure. */
export class TemplateAssistPiiBlockedError extends Error {
  readonly code = "pii_blocked" as const

  constructor() {
    super("Template assist blocked by PII gate")
    this.name = "TemplateAssistPiiBlockedError"
  }
}

export interface TemplateDraft {
  name: string
  description?: string
  body: string
}

export interface TemplateParamSuggestion {
  id: string
  label: string
  description?: string
  required: boolean
  kind: "string" | "enum" | "resource"
  options?: string[]
  resourceKind?: ResourceParamKind
  multiline?: boolean
}

const DRAFT_SCHEMA = z.object({
  name: z.string().describe("Short noun phrase naming the template, at most 40 characters"),
  description: z
    .string()
    .optional()
    .describe("One clause — what the message is for. Omit if the name says it."),
  body: z
    .string()
    .describe(
      "The reusable message. {{snake_case}} tokens mark the parts the user fills in each time."
    ),
})

const SUGGESTIONS_SCHEMA = z.object({
  suggestions: z
    .array(
      z.object({
        id: z.string().describe("The {{token}} id, exactly as it appears in the body"),
        label: z.string().describe("Short human label for the fill-in field"),
        description: z
          .string()
          .optional()
          .describe(
            'One short hint shown while the slot is being filled — what belongs in it ("the service to deploy"), not the label repeated'
          ),
        required: z.boolean().describe("Whether the message makes no sense without it"),
        kind: z
          .enum(["string", "enum", "resource"])
          .describe("string = free text, enum = pick from options, resource = a mentionable thing"),
        options: z
          .array(z.string())
          .optional()
          .describe("The choices, when kind is enum. 2-8, mutually exclusive."),
        resourceKind: z
          .enum(RESOURCE_PARAM_KINDS)
          .optional()
          .describe("What the reference points at, when kind is resource"),
        multiline: z
          .boolean()
          .optional()
          .describe("True when the answer is naturally several lines (a paste, a list)"),
      })
    )
    .describe("One suggestion per {{token}} in the body"),
})

// The three system prompts are editable in the Prompt Center (ADR-0236).
// They talk ABOUT `{{token}}` slots, so each literal token they mention is a
// declared variable rendered back as itself: the template engine leaves the
// text byte-identical, and an override may keep or drop those examples.

/** Placeholder names the shipped wording mentions literally. */
const LITERAL_TOKEN_NAMES = ["parameter", "snake_case", "token", "tokens"] as const

/** Values that render each literal token back as itself. */
const LITERAL_TOKEN_VALUES: Readonly<Record<string, string>> = Object.fromEntries(
  LITERAL_TOKEN_NAMES.map((name) => [name, `{{${name}}}`])
)

const TEMPLATE_ASSIST_SHARED = {
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account"],
  activation: "next-operation",
  hosts: ["app"],
  maxChars: 8_000,
  variables: LITERAL_TOKEN_NAMES.map((name) => ({ name, required: false, maxChars: 32 })),
  consumers: ["lib/ai/generation/template-assist.ts"],
} as const satisfies Partial<PromptDefinitionInput>

/** Intent -> draft template. */
export const TEMPLATE_ASSIST_GENERATE_PROMPT = definePrompt({
  ...TEMPLATE_ASSIST_SHARED,
  id: "generation.template-assist.generate",
  // The reply is parsed against the draft schema.
  risk: "protocol",
  outputContract:
    "A JSON object {name, description?, body} validated against the draft schema; the body's tokens are re-derived, never trusted as declarations.",
  defaultBody: `You write message templates for an AI chat app.
A template is a message the user sends repeatedly: fixed prose plus {{parameter}} slots that get filled in just before sending.

- The body is the message itself — write it ready to send, in the user's language.
- Use {{snake_case}} tokens for every part the user should customize each time: names, files, dates, choices, pasted content.
- Prefer few, well-named slots (1-4). A slot nobody would fill is clutter.
- Never put a {{token}} inside backticks or a code fence — the app treats those as literal text, and the slot would never be asked for.
- Return JSON matching the schema.`,
})

/** Body -> rewritten body. */
export const TEMPLATE_ASSIST_IMPROVE_PROMPT = definePrompt({
  ...TEMPLATE_ASSIST_SHARED,
  id: "generation.template-assist.improve",
  risk: "ordinary",
  outputContract: "The rewritten message as plain text, trimmed; it replaces the editor's body.",
  defaultBody: `You rewrite chat message templates — messages with {{parameter}} slots that get filled in before sending.

- Keep every {{token}} exactly as written, including position inside sentences. Tokens inside backticks or code fences stay inside them.
- Keep Markdown structure and the user's language.
- Make it clearer and tighter; do not add new {{tokens}} unless the instruction asks for one.
- Return ONLY the rewritten message — no preamble, no explanation.`,
})

/** Body -> annotations for its tokens. */
export const TEMPLATE_ASSIST_SUGGEST_PARAMS_PROMPT = definePrompt({
  ...TEMPLATE_ASSIST_SHARED,
  id: "generation.template-assist.suggest-params",
  // The reply is parsed against the suggestions schema.
  risk: "protocol",
  outputContract:
    "A JSON object {suggestions: [...]} validated against the suggestions schema; suggestions for tokens the body lacks are dropped.",
  defaultBody: `You annotate the {{parameter}} slots of a chat message template.
For each token in the body, decide how the app should ask the user to fill it:

- label: a short human name ("Module", "Tone") — never the raw token repeated.
- description: one short hint shown while the user fills the slot — what belongs in it ("the service to deploy", "which file to explain"). Omit when the label already says it.
- kind: "string" for free text; "enum" when the sensible answers are a small fixed set (supply the options); "resource" when the slot wants a real thing — a workspace file, an agent, a subagent, a team member (supply resourceKind).
- required: false only when sending without it is reasonable.
- multiline: true for slots that take pasted paragraphs or lists.

Emit one suggestion per {{token}} that appears in the body, in body order. Do not invent tokens.`,
})

/** Resolve one system prompt, then honour a cancel that landed meanwhile. */
async function systemFor(
  def: PromptDefinitionV1,
  abortSignal: AbortSignal | undefined
): Promise<string> {
  const system = (await resolvePromptAsync(def, { values: LITERAL_TOKEN_VALUES })).text
  abortSignal?.throwIfAborted()
  return system
}

function assertSendable(system: string, prompt: string): void {
  if (!hasNoLeakingPii(system) || !hasNoLeakingPii(prompt)) {
    throw new TemplateAssistPiiBlockedError()
  }
}

/**
 * Turn a one-line intent into a draft template. The body's `{{tokens}}` are
 * not trusted back into declarations here — the caller derives them with
 * `deriveParams`, the same way hand-typed bodies are read.
 */
export async function generateTemplateDraft(
  model: LanguageModel,
  intent: string,
  options?: { abortSignal?: AbortSignal; generate?: GenerationSeam }
): Promise<TemplateDraft> {
  const prompt = `Template request: ${intent.trim()}`
  const system = await systemFor(TEMPLATE_ASSIST_GENERATE_PROMPT, options?.abortSignal)
  assertSendable(system, prompt)
  const text = await generateThroughSeam(
    options?.generate,
    {
      stage: "generate",
      modelId: modelIdOf(model),
      system,
      prompt,
      temperature: 0.7,
      abortSignal: options?.abortSignal,
    },
    async (overrides) => {
      const result = await generateObject({
        model,
        schema: DRAFT_SCHEMA,
        system,
        prompt,
        temperature: 0.7,
        abortSignal: options?.abortSignal,
        ...overrides,
      })
      return {
        text: JSON.stringify(result.object),
        usage: result.usage,
        providerMetadata: result.providerMetadata,
      }
    }
  )
  return normalizeDraft(DRAFT_SCHEMA.parse(JSON.parse(text)))
}

/** Rewrite a body for clarity. Tokens are contract — they must survive verbatim. */
export async function improveTemplateBody(
  model: LanguageModel,
  body: string,
  options?: { instruction?: string; abortSignal?: AbortSignal; generate?: GenerationSeam }
): Promise<string> {
  const instruction = options?.instruction?.trim()
  const prompt = instruction ? `${body}\n\nInstruction: ${instruction}` : body
  const system = await systemFor(TEMPLATE_ASSIST_IMPROVE_PROMPT, options?.abortSignal)
  assertSendable(system, prompt)
  const text = await generateThroughSeam(
    options?.generate,
    {
      stage: "improve",
      modelId: modelIdOf(model),
      system,
      prompt,
      temperature: 0.4,
      abortSignal: options?.abortSignal,
    },
    (overrides) =>
      generateText({
        model,
        system,
        prompt,
        temperature: 0.4,
        abortSignal: options?.abortSignal,
        ...overrides,
      })
  )
  return text.trim()
}

/**
 * Ask the model how each `{{token}}` should be declared, then apply the
 * answer through {@link applyParamSuggestions} — which is where suggestions
 * meet reality (unknown ids dropped, enum without options demoted, and so
 * on).
 */
export async function suggestTemplateParams(
  model: LanguageModel,
  body: string,
  options?: { abortSignal?: AbortSignal; generate?: GenerationSeam }
): Promise<TemplateParamSuggestion[]> {
  const system = await systemFor(TEMPLATE_ASSIST_SUGGEST_PARAMS_PROMPT, options?.abortSignal)
  assertSendable(system, body)
  const text = await generateThroughSeam(
    options?.generate,
    {
      stage: "suggest",
      modelId: modelIdOf(model),
      system,
      prompt: body,
      temperature: 0.3,
      abortSignal: options?.abortSignal,
    },
    async (overrides) => {
      const result = await generateObject({
        model,
        schema: SUGGESTIONS_SCHEMA,
        system,
        prompt: body,
        temperature: 0.3,
        abortSignal: options?.abortSignal,
        ...overrides,
      })
      return {
        text: JSON.stringify(result.object),
        usage: result.usage,
        providerMetadata: result.providerMetadata,
      }
    }
  )
  return SUGGESTIONS_SCHEMA.parse(JSON.parse(text)).suggestions
}

/**
 * Merge model suggestions into the declarations a body actually has.
 *
 * The body is authoritative: `deriveParams` produces the list, and a
 * suggestion can only annotate a declaration that exists — a suggestion for a
 * token the body does not contain is dropped, and every undiscovered token
 * keeps its derived default. Kind changes go through `paramKindChange`, the
 * same path the editor's own type picker takes, so a suggested `enum` without
 * options degrades to `string` instead of saving an unfillable choice list.
 */
export function applyParamSuggestions(
  body: string,
  existing: readonly ChatTemplateParam[],
  suggestions: readonly TemplateParamSuggestion[]
): ChatTemplateParam[] {
  const byId = new Map(suggestions.map((s) => [s.id, s]))
  return deriveParams(body, existing).map((param) => {
    const suggestion = byId.get(param.id)
    if (!suggestion) return param

    let kind: ChatTemplateParam["kind"] = param.kind
    if (suggestion.kind === "enum" && (suggestion.options ?? []).length > 0) {
      kind = "enum"
    } else if (suggestion.kind === "resource") {
      kind = "resource"
    } else if (suggestion.kind === "string") {
      kind = "string"
    }
    // `paramKindChange` returns the PATCH a kind switch implies — merge it
    // over the declaration rather than replacing it (the patch carries only
    // `kind`, and `resourceKind` when one was needed).
    const next = { ...param, ...paramKindChange(param, kind) }

    if (suggestion.label.trim()) next.label = suggestion.label.trim()
    if (suggestion.description?.trim()) next.description = suggestion.description.trim()
    next.required = suggestion.required
    if (next.kind === "enum") {
      next.options = (suggestion.options ?? []).map((o) => o.trim()).filter(Boolean)
    }
    if (next.kind === "resource" && suggestion.resourceKind) {
      next.resourceKind = suggestion.resourceKind
    }
    if (next.kind === "string" && suggestion.multiline !== undefined) {
      next.multiline = suggestion.multiline || undefined
    }
    return next
  })
}

/** Normalize a model draft: trimmed, name clamped, description dropped when empty. */
export function normalizeDraft(raw: z.infer<typeof DRAFT_SCHEMA>): TemplateDraft {
  const name = raw.name.trim().slice(0, 60) || "Untitled template"
  const description = raw.description?.trim()
  return {
    name,
    ...(description ? { description } : {}),
    body: raw.body,
  }
}
