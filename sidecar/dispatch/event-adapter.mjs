// Translate Vercel AI SDK stream events into the SDKMessage shapes that
// `lib/claude/adapter.ts` consumes. Keeping this in one module is the core
// of the multi-provider port — everything downstream of the sidecar stays
// unchanged because the wire shape is preserved.
//
// Vercel AI SDK events we care about (subset of `result.fullStream`):
//   { type: "text-delta", textDelta: string }
//   { type: "reasoning", textDelta: string }     // o1/o3 / claude thinking
//   { type: "tool-call", toolCallId, toolName, args }
//   { type: "tool-result", toolCallId, result }
//   { type: "finish", finishReason, usage: { promptTokens, completionTokens, totalTokens } }
//   { type: "error", error }
//
// SDKMessage shapes we emit (mirrors @anthropic-ai/claude-agent-sdk):
//   { type: "system", subtype: "init", session_id, ... }   — emitted once at start
//   { type: "assistant", message: { id, content: BetaContentBlock[] }, session_id, uuid }
//   { type: "result", subtype, session_id, usage, total_cost_usd, duration_ms, num_turns }

import { randomUUID } from "node:crypto"

/**
 * Build a stateful translator. Call `.handle(event)` for each Vercel-AI-SDK
 * event; it returns zero or more SDKMessage objects to emit. Call `.finish(usage?)`
 * once the upstream stream completes to produce the trailing result message.
 *
 * State machine: we accumulate text-delta / reasoning chunks into a single
 * assistant content block and emit a fresh `assistant` message every time the
 * block boundary changes (text → reasoning → tool_use). Each emitted message
 * carries the same `id` until the boundary changes, so the renderer's id-keyed
 * dedup logic replaces the in-progress version with the final one.
 *
 * @param {{
 *   sessionId: string,
 *   sdkSessionId: string,
 *   model?: string,
 *   provider: string,
 *   startedAt?: number,
 * }} ctx
 */
export function createEventAdapter(ctx) {
  const startedAt = ctx.startedAt ?? Date.now()
  let messageId = randomUUID()
  /** @type {"text"|"reasoning"|"tool_use"|null} */
  let activeBlockKind = null
  /** @type {string} */
  let textBuf = ""
  /** @type {string} */
  let reasoningBuf = ""
  /** @type {Array<{ type: "tool_use", id: string, name: string, input: any }>} */
  const completedToolUses = []
  let initEmitted = false
  let lastUsage = null

  function emitInitIfNeeded(out) {
    if (initEmitted) return
    initEmitted = true
    out.push({
      type: "system",
      subtype: "init",
      session_id: ctx.sdkSessionId,
      cwd: undefined,
      tools: [],
      mcp_servers: [],
      model: ctx.model,
      permissionMode: "default",
      apiKeySource: "user",
    })
  }

  function buildToolResultMessage(toolCallId, content, isError) {
    return {
      type: "user",
      session_id: ctx.sdkSessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolCallId ?? "",
            content,
            is_error: isError,
          },
        ],
      },
    }
  }

  function buildAssistantSnapshot() {
    const content = []
    if (textBuf) content.push({ type: "text", text: textBuf })
    if (reasoningBuf) content.push({ type: "thinking", thinking: reasoningBuf })
    for (const tu of completedToolUses) content.push(tu)
    return {
      type: "assistant",
      session_id: ctx.sdkSessionId,
      uuid: randomUUID(),
      parent_tool_use_id: null,
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model: ctx.model,
        content,
        stop_reason: null,
        stop_sequence: null,
      },
    }
  }

  return {
    /**
     * @param {any} event
     * @returns {Array<any>}
     */
    handle(event) {
      const out = []
      emitInitIfNeeded(out)

      switch (event?.type) {
        case "text-delta": {
          if (activeBlockKind === "tool_use") {
            // Boundary change — start a new message id so the renderer
            // doesn't merge text after a tool_use into the same block.
            messageId = randomUUID()
          }
          activeBlockKind = "text"
          // v6 high-level fullStream uses `text`; v4 used `textDelta`; the
          // low-level model stream uses `delta`. Accept all three.
          textBuf += event.text ?? event.textDelta ?? event.delta ?? ""
          out.push(buildAssistantSnapshot())
          return out
        }
        case "reasoning":
        case "reasoning-delta": {
          activeBlockKind = "reasoning"
          reasoningBuf += event.text ?? event.textDelta ?? event.delta ?? ""
          out.push(buildAssistantSnapshot())
          return out
        }
        case "tool-call": {
          activeBlockKind = "tool_use"
          completedToolUses.push({
            type: "tool_use",
            id: event.toolCallId ?? randomUUID(),
            name: event.toolName ?? "unknown",
            input: event.args ?? event.input ?? {},
          })
          out.push(buildAssistantSnapshot())
          return out
        }
        case "tool-result": {
          // Mirror the Anthropic SDK shape: tool results arrive as a synthetic
          // user message with `tool_result` content blocks. v6 carries the
          // payload in `output`; v4 used `result`.
          const payload = event.output ?? event.result
          const flat = typeof payload === "string" ? payload : JSON.stringify(payload)
          out.push(buildToolResultMessage(event.toolCallId, flat, Boolean(event.isError)))
          return out
        }
        case "tool-error": {
          // v6 surfaces a thrown tool `execute` as a distinct event. Project it
          // as an errored tool_result so the model can recover and the renderer
          // styles it as a failure.
          const err = event.error
          const msg =
            err instanceof Error ? err.message : typeof err === "string" ? err : JSON.stringify(err)
          out.push(buildToolResultMessage(event.toolCallId, msg, true))
          return out
        }
        case "finish": {
          lastUsage = event.usage ?? null
          // Don't emit `result` here — `finish` is the closing event of the
          // fullStream; the caller invokes `.finish()` to emit the SDK
          // result message after the loop exits cleanly.
          return out
        }
        case "error": {
          // Errors are emitted by the dispatcher as a `session_ended` with
          // an error string — adapter doesn't translate them.
          return out
        }
        default:
          return out
      }
    },

    /**
     * Called once the upstream stream has completed cleanly. Produces the
     * trailing `result` SDKMessage with usage / cost / duration so the
     * renderer can attach metadata to the final assistant message.
     *
     * @param {{ totalCostUsd?: number, usage?: any } | undefined} info
     * @returns {Array<any>}
     */
    finish(info) {
      const out = []
      emitInitIfNeeded(out)
      const usage = info?.usage ?? lastUsage ?? {}
      const result = {
        type: "result",
        subtype: "success",
        session_id: ctx.sdkSessionId,
        is_error: false,
        duration_ms: Date.now() - startedAt,
        duration_api_ms: Date.now() - startedAt,
        num_turns: 1,
        total_cost_usd: info?.totalCostUsd ?? 0,
        usage: {
          input_tokens: usage.promptTokens ?? usage.inputTokens ?? 0,
          output_tokens: usage.completionTokens ?? usage.outputTokens ?? 0,
          cache_creation_input_tokens: usage.cacheCreationInputTokens ?? 0,
          cache_read_input_tokens: usage.cacheReadInputTokens ?? 0,
        },
      }
      out.push(result)
      return out
    },
  }
}
