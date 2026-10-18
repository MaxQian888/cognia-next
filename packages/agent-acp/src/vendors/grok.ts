import type {
  AcpElicitationPropertySchema,
  AcpElicitationResponse,
  ExternalAgentTokenUsage,
} from "@cognia/agent-contracts/external-agent"
import { JsonRpcMethodError } from "@cognia/agent-runtime-kit/json-rpc-peer"
import type { AcpVendorProfile } from "../vendor-profile"

interface GrokQuestion {
  question: string
  options: Array<{ label: string; description: string; preview?: string }>
  multiSelect?: boolean | null
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function invalidQuestion(): never {
  throw new JsonRpcMethodError(-32602, "Invalid Grok user question request")
}

function questionsFrom(params: Record<string, unknown> | undefined): GrokQuestion[] {
  if (
    !params ||
    typeof params.sessionId !== "string" ||
    !params.sessionId ||
    typeof params.toolCallId !== "string" ||
    !params.toolCallId ||
    !["default", "plan"].includes(String(params.mode)) ||
    !Array.isArray(params.questions) ||
    params.questions.length === 0 ||
    params.questions.length > 32
  )
    invalidQuestion()
  const questions: GrokQuestion[] = []
  const prompts = new Set<string>()
  for (const q of params.questions) {
    if (
      !record(q) ||
      typeof q.question !== "string" ||
      !q.question.trim() ||
      prompts.has(q.question) ||
      !Array.isArray(q.options) ||
      (q.multiSelect !== undefined && q.multiSelect !== null && typeof q.multiSelect !== "boolean")
    )
      invalidQuestion()
    const labels = new Set<string>()
    for (const option of q.options) {
      if (
        !record(option) ||
        typeof option.label !== "string" ||
        !option.label.trim() ||
        labels.has(option.label) ||
        typeof option.description !== "string" ||
        (option.preview !== undefined &&
          option.preview !== null &&
          typeof option.preview !== "string")
      )
        invalidQuestion()
      labels.add(option.label)
    }
    prompts.add(q.question)
    questions.push(q as unknown as GrokQuestion)
  }
  return questions
}

function questionRequest(params: Record<string, unknown> | undefined): Record<string, unknown> {
  const questions = questionsFrom(params)
  const properties: Record<string, AcpElicitationPropertySchema> = {}
  questions.forEach((q, index) => {
    const id = `q${index}`
    const oneOf = q.options.map((option) => ({ const: option.label, title: option.label }))
    properties[id] = q.multiSelect
      ? { type: "array", title: q.question, items: { type: "string", oneOf } }
      : { type: "string", title: q.question, ...(oneOf.length ? { oneOf } : {}) }
    properties[`${id}_notes`] = { type: "string", title: q.question, format: "multiline" }
  })
  return {
    mode: "form",
    sessionId: params!.sessionId,
    toolCallId: params!.toolCallId,
    message: questions[0].question,
    requestedSchema: { type: "object", properties },
    _meta: {
      userInput: {
        questions: questions.map((q, index) => ({
          id: `q${index}`,
          notesField: `q${index}_notes`,
          question: q.question,
          options: q.options,
          multiple: q.multiSelect === true,
          isOther: true,
        })),
      },
    },
  }
}

function prepareQuestionResponse(
  response: AcpElicitationResponse,
  params: Record<string, unknown> | undefined
): AcpElicitationResponse {
  if (response.action !== "accept" || !response.content) return response
  const content = { ...response.content }
  questionsFrom(params).forEach((question, index) => {
    // The shared form initializes an unselected radio group to "". It is an
    // absent optional choice, not a label outside Grok's offered options.
    if (!question.multiSelect && content[`q${index}`] === "") delete content[`q${index}`]
  })
  return { ...response, content }
}

function questionResponse(
  response: Omit<AcpElicitationResponse, "requestId">,
  params: Record<string, unknown> | undefined
): unknown {
  if (response.action !== "accept") return { outcome: "cancelled" }
  const answers: Record<string, string[]> = Object.create(null)
  const annotations: Record<string, { notes?: string; preview?: string }> = Object.create(null)
  const questions = questionsFrom(params)
  for (const [index, question] of questions.entries()) {
    const selected = response.content?.[`q${index}`]
    const notes = response.content?.[`q${index}_notes`]
    const values =
      typeof selected === "string"
        ? selected
          ? [selected]
          : []
        : Array.isArray(selected)
          ? selected
          : []
    const labels = new Set(question.options.map((option) => option.label))
    if (
      (!question.multiSelect && values.length > 1) ||
      new Set(values).size !== values.length ||
      values.some((value) => !labels.has(value)) ||
      (notes !== undefined && typeof notes !== "string") ||
      (values.length === 0 && !(typeof notes === "string" && notes.trim()))
    )
      return { outcome: "cancelled" }
    answers[question.question] = values.length ? values : ["Other"]
    const preview =
      !question.multiSelect && values.length === 1
        ? question.options.find((option) => option.label === values[0])?.preview
        : undefined
    if ((typeof notes === "string" && notes.trim()) || preview) {
      annotations[question.question] = {
        ...(typeof notes === "string" && notes.trim() ? { notes } : {}),
        ...(preview ? { preview } : {}),
      }
    }
  }
  return {
    outcome: "accepted",
    answers,
    ...(Object.keys(annotations).length ? { annotations } : {}),
  }
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

/** xAI aggregates every model call in this prompt; its flat metadata is last-call only. */
function promptUsage(result: {
  _meta?: Record<string, unknown> | null
}): ExternalAgentTokenUsage | undefined {
  const usage = result._meta?.usage
  if (
    !record(usage) ||
    !count(usage.inputTokens) ||
    !count(usage.outputTokens) ||
    !count(usage.totalTokens)
  )
    return undefined
  const optional = ["cachedReadTokens", "cacheCreationTokens", "reasoningTokens"] as const
  if (optional.some((key) => usage[key] !== undefined && usage[key] !== null && !count(usage[key])))
    return undefined
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    // Cache reads are part of input; reasoning is part of output. Never add them twice.
    totalTokens: usage.totalTokens,
    ...(count(usage.cachedReadTokens) ? { cacheReadTokens: usage.cachedReadTokens } : {}),
    ...(count(usage.cacheCreationTokens) ? { cacheWriteTokens: usage.cacheCreationTokens } : {}),
    ...(count(usage.reasoningTokens) ? { reasoningTokens: usage.reasoningTokens } : {}),
  }
}

/** Grok Build 1.0.62 extensions; the host still owns every decision and cancellation. */
export const grokAcpProfile: AcpVendorProfile = Object.freeze<AcpVendorProfile>({
  id: "grok",
  label: "Grok Build",
  commandNames: ["grok"],
  promptUsage,
  elicitationExtensions: {
    "_x.ai/ask_user_question": {
      request: questionRequest,
      prepareResponse: prepareQuestionResponse,
      response: questionResponse,
    },
  },
})
