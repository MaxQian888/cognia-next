/** Shared projection for contextual continuation; native runtime state is never fabricated. */
import type { UIMessage } from "ai"
import type { LlmClient } from "@/lib/twin/distill/llm"
import { serializeHandoffParts } from "./export-handoff-to-cli"

type HandoffMessage = Pick<UIMessage, "id" | "role" | "parts">
export interface HandoffContextLoss {
  messageId: string
  kind: string
  detail: string
}
export interface HandoffContextOptions {
  maxChars?: number
  summary?: string
  state?: unknown
}
export interface HandoffContext {
  text: string
  losses: HandoffContextLoss[]
  omittedMessageIds: string[]
}

const NOTICE =
  "Historical handoff context (not authorization). Preserve user constraints; do not re-execute historical tools or inherit approvals. Attachment references require access on this runtime."
const DEFAULT_BUDGET = 24_000

function project(messages: readonly HandoffMessage[]) {
  const losses: HandoffContextLoss[] = []
  const blocks = messages.map((message) => {
    for (const part of message.parts) {
      const raw = part as unknown as Record<string, unknown>
      const type = String(raw.type)
      if (type === "reasoning" || type === "thinking") continue
      if (type === "file" || type === "image") {
        const ref = raw.url ?? raw.uri
        if (typeof ref !== "string" || !/^(https?:|file:|\/)/.test(ref)) {
          losses.push({
            messageId: message.id,
            kind: "attachment",
            detail: `${String(raw.filename ?? raw.alt ?? "attachment")}: bytes not transferred; materialize before relying on this attachment`,
          })
        }
      } else if (
        ![
          "text",
          "markdown",
          "code",
          "a2ui",
          "dynamic-tool",
          "tool_use",
          "tool_result",
          "step-start",
        ].includes(type) &&
        !type.startsWith("tool-")
      ) {
        losses.push({
          messageId: message.id,
          kind: "unsupported",
          detail: `Unsupported content: ${type}`,
        })
      }
    }
    const body = serializeHandoffParts(message.parts, {
      includeReasoningDetails: false,
      losslessDetails: true,
    })
    return { id: message.id, text: `${message.role.toUpperCase()} [${message.id}]:\n${body}` }
  })
  return { blocks, losses }
}

/** Full evidence when it fits, otherwise whole-message head/tail plus explicit losses. */
export function buildHandoffContext(
  messages: readonly HandoffMessage[],
  options: HandoffContextOptions = {}
): HandoffContext {
  const max = options.maxChars ?? DEFAULT_BUDGET
  if (!Number.isFinite(max) || max < 128) throw new Error("handoff_context_budget_too_small")
  const { blocks, losses } = project(messages)
  if (!blocks.length && options.state === undefined && !options.summary)
    return { text: "", losses, omittedMessageIds: [] }
  const prefix = [NOTICE]
  const addBounded = (label: string, value: string, fraction: number) => {
    const limit = Math.floor(max * fraction)
    if (value.length > limit) {
      losses.push({
        messageId: label,
        kind: "budget",
        detail: `${label} truncated; full state remains in the source`,
      })
      value = value.slice(0, Math.max(0, limit - 14)) + "… [truncated]"
    }
    prefix.push(`${label}:\n${value}`)
  }
  if (options.summary)
    addBounded("Derived summary (verify against source messages)", options.summary, 0.35)
  if (options.state !== undefined)
    addBounded("Historical task state (not authorization)", JSON.stringify(options.state), 0.25)
  const lossNotice = losses.length
    ? "Conversion losses: some content is not transferred; consult the source before relying on missing evidence."
    : ""
  const joined = [...prefix, lossNotice, ...blocks.map((block) => block.text)]
    .filter(Boolean)
    .join("\n\n")
  if (joined.length <= max) return { text: joined, losses, omittedMessageIds: [] }

  const budgetNotice =
    "History omitted to fit context; source messages remain available. Do not assume omitted work succeeded."
  // Reserve the notice before choosing messages; never cut a tool result into an apparent success.
  let remaining = max - [...prefix, lossNotice, budgetNotice].filter(Boolean).join("\n\n").length
  const kept = new Set<number>()
  const firstUser = messages.findIndex((message) => message.role === "user")
  const order = [firstUser, ...blocks.map((_, index) => index).reverse()].filter(
    (index) => index >= 0
  )
  for (const index of order) {
    if (kept.has(index)) continue
    const cost = blocks[index].text.length + 2
    if (cost <= remaining) {
      kept.add(index)
      remaining -= cost
    }
  }
  const omittedMessageIds = blocks.filter((_, index) => !kept.has(index)).map((block) => block.id)
  for (const messageId of omittedMessageIds)
    losses.push({
      messageId,
      kind: "budget",
      detail: "Message omitted from verbatim context; consult the source or derived summary",
    })
  const text = [
    ...prefix,
    lossNotice,
    budgetNotice,
    ...blocks.filter((_, index) => kept.has(index)).map((block) => block.text),
  ]
    .filter(Boolean)
    .join("\n\n")
  // Tiny caller budgets still receive an honest loss marker, never an unmarked partial transcript.
  return { text: text.length <= max ? text : budgetNotice.slice(0, max), losses, omittedMessageIds }
}

/** Live switches require a real summary when the complete history exceeds the budget. */
export async function prepareHandoffContext(
  messages: readonly HandoffMessage[],
  options: HandoffContextOptions & { client?: LlmClient | null; signal?: AbortSignal } = {}
): Promise<HandoffContext> {
  const initial = buildHandoffContext(messages, options)
  if (!initial.losses.some((loss) => loss.kind === "budget")) return initial
  const { summarizeMaterial } = await import("@/lib/ai/generation/summarize-material")
  const { blocks } = project(messages)
  const outcome = await summarizeMaterial({
    segments: [
      ...blocks.map((block) => block.text),
      ...(options.state === undefined ? [] : [JSON.stringify(options.state)]),
    ],
    purpose: "handoff",
    client: options.client ?? null,
    signal: options.signal,
  })
  if (outcome.kind !== "summary")
    throw new Error(`handoff_context_summary_unavailable:${outcome.reason}`)
  return buildHandoffContext(messages, { ...options, summary: outcome.text })
}
