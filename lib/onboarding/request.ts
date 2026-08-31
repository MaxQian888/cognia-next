import type { OnboardingIntent } from "@cognia/agent-config-types"
import type { UIMessage } from "ai"

import { resolveToolPartName } from "@/lib/chat/tool-summary"

const STORAGE_KEY = "cognia:onboarding-requests:v1"

export type OnboardingRequestState = "awaiting-input" | "in-flight" | "failed" | "succeeded"

export interface OnboardingRequestRecord {
  id: string
  idempotencyKey: string
  cardId: OnboardingIntent
  sessionId: string
  skillId: string
  prompt: string
  state: OnboardingRequestState
  clarificationUsed: boolean
  attempts: number
  baselineMessageIds: string[]
  toolReceiptIds: string[]
  createdAt: number
  updatedAt: number
  dispatchedAt?: number
  settledAt?: number
  resultMessageId?: string
  lastError?: string
}

interface RequestBook {
  version: 1
  requests: Record<string, OnboardingRequestRecord>
}

interface CreateInput {
  cardId: OnboardingIntent
  sessionId: string
  skillId: string
  prompt: string
  now?: number
}

interface TransitionOptions {
  now?: number
}

function emptyBook(): RequestBook {
  return { version: 1, requests: {} }
}

function hasStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined"
}

function isState(value: unknown): value is OnboardingRequestState {
  return (
    value === "awaiting-input" ||
    value === "in-flight" ||
    value === "failed" ||
    value === "succeeded"
  )
}

function validRecord(value: unknown): value is OnboardingRequestRecord {
  if (!value || typeof value !== "object") return false
  const row = value as Partial<OnboardingRequestRecord>
  return (
    typeof row.id === "string" &&
    typeof row.idempotencyKey === "string" &&
    (row.cardId === "read-folder" ||
      row.cardId === "extract-text" ||
      row.cardId === "summarize-web") &&
    typeof row.sessionId === "string" &&
    typeof row.skillId === "string" &&
    typeof row.prompt === "string" &&
    isState(row.state) &&
    typeof row.clarificationUsed === "boolean" &&
    typeof row.attempts === "number" &&
    Array.isArray(row.baselineMessageIds) &&
    row.baselineMessageIds.every((id) => typeof id === "string") &&
    Array.isArray(row.toolReceiptIds) &&
    row.toolReceiptIds.every((id) => typeof id === "string") &&
    typeof row.createdAt === "number" &&
    typeof row.updatedAt === "number"
  )
}

function readBook(): RequestBook {
  if (!hasStorage()) return emptyBook()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) return emptyBook()
  try {
    const value = JSON.parse(raw) as Partial<RequestBook>
    if (value.version !== 1 || !value.requests || typeof value.requests !== "object") {
      throw new Error("invalid onboarding request book")
    }
    const requests = Object.fromEntries(
      Object.entries(value.requests).filter((entry): entry is [string, OnboardingRequestRecord] =>
        validRecord(entry[1])
      )
    )
    return { version: 1, requests }
  } catch {
    window.localStorage.removeItem(STORAGE_KEY)
    return emptyBook()
  }
}

function writeBook(book: RequestBook): void {
  if (hasStorage()) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(book))
}

function save(record: OnboardingRequestRecord): OnboardingRequestRecord {
  const book = readBook()
  book.requests[record.sessionId] = record
  writeBook(book)
  return record
}

export function createOnboardingRequest(input: CreateInput): OnboardingRequestRecord {
  const existing = readOnboardingRequest(input.sessionId)
  const idempotencyKey = `onboarding:${input.sessionId}:${input.cardId}`
  if (existing?.idempotencyKey === idempotencyKey) return existing
  const now = input.now ?? Date.now()
  return save({
    id: idempotencyKey,
    idempotencyKey,
    cardId: input.cardId,
    sessionId: input.sessionId,
    skillId: input.skillId,
    prompt: input.prompt.trim(),
    state: "awaiting-input",
    clarificationUsed: false,
    attempts: 0,
    baselineMessageIds: [],
    toolReceiptIds: [],
    createdAt: now,
    updatedAt: now,
  })
}

export function readOnboardingRequest(sessionId: string): OnboardingRequestRecord | null {
  return readBook().requests[sessionId] ?? null
}

export function beginOnboardingRequestAttempt(
  sessionId: string,
  options: TransitionOptions = {}
): OnboardingRequestRecord | null {
  const record = readOnboardingRequest(sessionId)
  if (!record || record.state === "succeeded") return record
  const now = options.now ?? Date.now()
  return save({
    ...record,
    state: "in-flight",
    attempts: record.attempts + 1,
    dispatchedAt: now,
    updatedAt: now,
    lastError: undefined,
  })
}

export function failOnboardingRequest(
  sessionId: string,
  error: string,
  options: TransitionOptions = {}
): OnboardingRequestRecord | null {
  const record = readOnboardingRequest(sessionId)
  if (!record || record.state === "succeeded") return record
  const now = options.now ?? Date.now()
  return save({ ...record, state: "failed", lastError: error, updatedAt: now })
}

function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<(typeof message.parts)[number], { type: "text" }> =>
        part.type === "text"
    )
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function successfulToolReceipts(
  messages: readonly UIMessage[]
): Array<{ id: string; name: string }> {
  const receipts: Array<{ id: string; name: string }> = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      const candidate = part as {
        type?: string
        toolName?: string
        toolCallId?: string
        state?: string
      }
      const name = resolveToolPartName(candidate)
      if (!name || candidate.state !== "output-available") continue
      receipts.push({
        id: candidate.toolCallId ?? `${message.id}:${name}`,
        name: name.toLowerCase(),
      })
    }
  }
  return receipts
}

function isRequiredReceipt(cardId: OnboardingIntent, name: string): boolean {
  const normalized = name.replace(/[.-]/g, "_").toLowerCase()
  switch (cardId) {
    case "read-folder":
      return (
        ["read", "glob", "grep", "ls", "bash", "shell", "list_directory"].includes(normalized) ||
        normalized.includes("filesystem")
      )
    case "extract-text":
      return false
    case "summarize-web":
      return (
        normalized === "web_fetch" ||
        normalized === "web_search" ||
        normalized === "fetch" ||
        normalized === "browser_fetch"
      )
  }
}

function requiredReceipts(
  cardId: OnboardingIntent,
  receipts: Array<{ id: string; name: string }>
): Array<{ id: string; name: string }> {
  if (cardId !== "extract-text") {
    return receipts.filter((receipt) => isRequiredReceipt(cardId, receipt.name))
  }
  const normalized = receipts.map((receipt) => ({
    ...receipt,
    normalized: receipt.name.replace(/[.-]/g, "_").toLowerCase(),
  }))
  const combined = normalized.find(
    (receipt) => receipt.normalized.includes("screenshot") && receipt.normalized.includes("ocr")
  )
  if (combined) return [combined]
  const screenshot = normalized.find(
    (receipt) =>
      receipt.normalized === "take_screenshot" ||
      (receipt.normalized.includes("screen") && receipt.normalized.includes("capture"))
  )
  const ocr = normalized.find(
    (receipt) =>
      receipt.normalized.includes("ocr") &&
      (receipt.normalized.includes("extract") || receipt.normalized === "ocr")
  )
  return screenshot && ocr ? [screenshot, ocr] : []
}

/**
 * True once `prompt` exists in the durable transcript as a user message.
 *
 * The handoff record now outlives the tab (localStorage, 24h TTL), so this is
 * the only thing standing between a reload that lands between the durable
 * write and the acknowledgement and a second dispatch of the same prompt. It
 * takes a bare string rather than a request record because non-onboarding
 * handoffs have no record and need exactly the same protection.
 */
export function hasPersistedPromptMessage(prompt: string, messages: readonly UIMessage[]): boolean {
  const target = prompt.trim()
  if (!target) return false
  return messages.some(
    (message) => message.role === "user" && messageText(message).trim() === target
  )
}

/** True once the fixed first prompt exists in the durable transcript. */
export function hasPersistedInitialOnboardingPrompt(
  record: OnboardingRequestRecord,
  messages: readonly UIMessage[]
): boolean {
  return hasPersistedPromptMessage(record.prompt, messages)
}

/**
 * Advance only from durable transcript evidence. A render-time assistant draft
 * cannot complete onboarding; callers pass `listMessages(sessionId)` output.
 */
export function reconcileOnboardingRequestMessages(
  sessionId: string,
  messages: readonly UIMessage[],
  options: TransitionOptions = {}
): OnboardingRequestRecord | null {
  const record = readOnboardingRequest(sessionId)
  if (!record || record.state !== "in-flight") return record

  const baseline = new Set(record.baselineMessageIds)
  const fresh = messages.filter((message) => !baseline.has(message.id))
  const userIndex = fresh.findIndex((message) => message.role === "user")
  if (userIndex < 0) return record
  const assistants = fresh.slice(userIndex + 1).filter((message) => message.role === "assistant")
  const result = [...assistants].reverse().find((message) => messageText(message).length > 0)
  if (!result) return record

  const now = options.now ?? Date.now()
  const receipts = requiredReceipts(record.cardId, successfulToolReceipts(assistants))
  if (receipts.length > 0) {
    return save({
      ...record,
      state: "succeeded",
      resultMessageId: result.id,
      toolReceiptIds: receipts.map((receipt) => receipt.id),
      baselineMessageIds: messages.map((message) => message.id),
      settledAt: now,
      updatedAt: now,
      lastError: undefined,
    })
  }

  const mayClarify = record.cardId === "read-folder" || record.cardId === "summarize-web"
  const asksForMissingInput = /[?？]\s*$/.test(messageText(result))
  if (mayClarify && asksForMissingInput && !record.clarificationUsed) {
    return save({
      ...record,
      state: "awaiting-input",
      clarificationUsed: true,
      baselineMessageIds: messages.map((message) => message.id),
      updatedAt: now,
    })
  }

  return save({
    ...record,
    state: "failed",
    baselineMessageIds: messages.map((message) => message.id),
    lastError: "required-tool-receipt-missing",
    settledAt: now,
    updatedAt: now,
  })
}
