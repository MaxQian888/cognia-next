import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

const DEFAULT_HOOK_BUDGET_USD = 0.25
const HOOK_PII_BLOCK_REASON = "Hook data blocked by the PII redaction gate"

export function createHookBudgetGovernor(maxBudgetUsd = DEFAULT_HOOK_BUDGET_USD) {
  const limit =
    typeof maxBudgetUsd === "number" && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0
      ? maxBudgetUsd
      : DEFAULT_HOOK_BUDGET_USD
  let spent = 0

  return {
    remaining() {
      return Math.max(0, limit - spent)
    },
    record(costUsd) {
      if (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0) {
        spent = Math.min(limit, spent + costUsd)
      }
    },
    exhausted() {
      return spent >= limit
    },
    snapshot() {
      return { limit, spent, remaining: Math.max(0, limit - spent) }
    },
  }
}

function handlerPrompt(handler, payloadJson) {
  const origin = '<hook-origin depth="1" />'
  if (handler.type === "mcp_tool") {
    return `${origin}\nCall the MCP tool ${handler.server}/${handler.tool} exactly once with this JSON input, then return the tool result as hook decision JSON:\n${JSON.stringify(handler.input ?? {})}`
  }
  if (handler.type === "prompt") {
    return `${origin}\nEvaluate this lifecycle hook. Return only Claude hook decision JSON.\nInstruction: ${handler.prompt}\nEvent payload: ${payloadJson}`
  }
  return `${origin}\nRun this lifecycle hook agent task. Return only Claude hook decision JSON when finished.\nTask: ${handler.prompt}\nEvent payload: ${payloadJson}`
}

function allowedToolsFor(handler, baseAllowedTools) {
  if (handler.type === "prompt") return []
  if (handler.type === "mcp_tool") return [`mcp__${handler.server}__${handler.tool}`]
  return baseAllowedTools
}

function redactProviderText(value, redact, piiGate) {
  try {
    const redacted = redact(String(value))
    return piiGate(redacted) ? redacted : null
  } catch {
    return null
  }
}

function redactToolResponse(value, redact, piiGate) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    return { ok: false }
  }
  if (serialized === undefined) serialized = String(value ?? "")
  try {
    const redacted = redact(serialized)
    if (!piiGate(redacted)) return { ok: false }
    return { ok: true, value: JSON.parse(redacted) }
  } catch {
    return { ok: false }
  }
}

function nestedPiiHooks(redact, piiGate) {
  return {
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            const result = redactToolResponse(input?.tool_response, redact, piiGate)
            if (!result.ok) {
              return { decision: "block", reason: HOOK_PII_BLOCK_REASON }
            }
            return {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                updatedToolOutput: result.value,
              },
            }
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        hooks: [
          async (input) => {
            const rawError = String(input?.error ?? "")
            const safeError = redactProviderText(rawError, redact, piiGate)
            // Failure hooks cannot rewrite `error`, so any required redaction
            // must stop the nested turn before the raw value reaches a model.
            if (safeError === null || safeError !== rawError) {
              return { decision: "block", reason: HOOK_PII_BLOCK_REASON }
            }
            return {}
          },
        ],
      },
    ],
  }
}

/**
 * SDK-native adapter for Claude's model-backed hook handlers. Nested hook
 * queries load no settings and register only a redaction-only PostToolUse
 * boundary, which marks them as hook-origin depth 1 and makes model-hook
 * recursion impossible by construction.
 */
export function createNativeHookExecutor({
  queryFn = sdkQuery,
  cwd,
  env,
  model,
  fallbackModel,
  mcpServers,
  allowedTools,
  maxBudgetUsd,
  budget = createHookBudgetGovernor(maxBudgetUsd),
  redact = (value) => redactText(value).redacted,
  piiGate = hasNoLeakingPiiDeep,
} = {}) {
  return async function executeNativeHook(handler, payloadJson, context = {}) {
    if (context.depth >= 1) {
      return { warning: "hook recursion depth exceeded (maximum 1)" }
    }
    if (budget.exhausted()) {
      return { block: "Hook model budget exhausted" }
    }

    const prompt = redactProviderText(handlerPrompt(handler, payloadJson), redact, piiGate)
    const permittedTools = allowedToolsFor(handler, allowedTools)
    if (prompt === null || !piiGate(permittedTools)) {
      return { block: HOOK_PII_BLOCK_REASON }
    }

    let q
    try {
      q = queryFn({
        prompt,
        options: {
          cwd,
          env,
          model: handler.model ?? model,
          fallbackModel,
          mcpServers,
          allowedTools: permittedTools,
          maxTurns: handler.type === "agent" ? 3 : handler.type === "mcp_tool" ? 2 : 1,
          maxBudgetUsd: budget.remaining(),
          settingSources: [],
          hooks: nestedPiiHooks(redact, piiGate),
        },
      })
    } catch (error) {
      return { warning: `hook ${handler.type} failed: ${error?.message ?? error}` }
    }

    const onAbort = () => {
      void q.interrupt?.()
    }
    if (context.signal?.aborted) onAbort()
    else context.signal?.addEventListener?.("abort", onAbort, { once: true })

    let result
    try {
      for await (const event of q) {
        if (event?.type === "result") result = event
      }
    } catch (error) {
      return { warning: `hook ${handler.type} failed: ${error?.message ?? error}` }
    } finally {
      context.signal?.removeEventListener?.("abort", onAbort)
    }

    budget.record(result?.total_cost_usd)
    if (!result) return { warning: `hook ${handler.type} produced no result` }
    if (result.is_error || result.subtype !== "success") {
      return { warning: `hook ${handler.type} failed: ${result.subtype ?? "unknown error"}` }
    }
    return { output: typeof result.result === "string" ? result.result : "" }
  }
}
