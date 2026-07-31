import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"
import type { SendContent, SendOptions } from "@cognia/agent-config-types"

export interface WorkbenchProviderPayload<TMessage = unknown> {
  content: SendContent
  messages: TMessage[]
  sendOptions: SendOptions
}

export class WorkbenchPiiGateBlocked extends Error {
  constructor() {
    super("Context Workbench provider payload failed the PII gate")
    this.name = "WorkbenchPiiGateBlocked"
  }
}

/**
 * Add private resource context to the provider-bound prompt. Callers must only
 * use this after plugin prompt hooks and visible-message construction so the
 * resource body never becomes part of the persisted user message.
 */
function attachResourceContext(content: SendContent, resourceContext: string): SendContent {
  if (!resourceContext) return content
  const contextBlock = `[Current resource context]\n${resourceContext}\n\n[User instruction]\n`
  return typeof content === "string"
    ? `${contextBlock}${content}`
    : [{ type: "text", text: contextBlock }, ...content]
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") return redactText(value).redacted
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return seen.get(value)
  if (value instanceof Date) return new Date(value)
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return value

  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    value.forEach((item) => output.push(redactValue(item, seen)))
    return output
  }

  const output: Record<string, unknown> = {}
  seen.set(value, output)
  Object.entries(value).forEach(([key, nested]) => {
    output[key] = redactValue(nested, seen)
  })
  return output
}

/**
 * Assemble and gate the provider-visible workbench text immediately before
 * dispatch. Runtime configuration (env/MCP credentials, cwd, tool allowlists)
 * is copied verbatim because it is not prompt text and redacting it can break
 * authentication or tool execution.
 */
export function gateWorkbenchProviderPayload<TMessage>(
  payload: WorkbenchProviderPayload<TMessage>,
  resourceContext = ""
): WorkbenchProviderPayload<TMessage> {
  const content = redactValue(
    attachResourceContext(payload.content, resourceContext),
    new WeakMap()
  ) as SendContent
  const messages = redactValue(payload.messages, new WeakMap()) as TMessage[]
  const sendOptions: SendOptions = {
    ...payload.sendOptions,
    ...(payload.sendOptions.systemPrompt
      ? { systemPrompt: redactText(payload.sendOptions.systemPrompt).redacted }
      : {}),
    ...(payload.sendOptions.appendSystemPrompt
      ? { appendSystemPrompt: redactText(payload.sendOptions.appendSystemPrompt).redacted }
      : {}),
  }
  const providerVisibleText = {
    content,
    messages,
    systemPrompt: sendOptions.systemPrompt,
    appendSystemPrompt: sendOptions.appendSystemPrompt,
  }
  if (!hasNoLeakingPiiDeep(providerVisibleText)) {
    throw new WorkbenchPiiGateBlocked()
  }
  return { content, messages, sendOptions }
}
