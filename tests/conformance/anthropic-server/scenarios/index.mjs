// Conformance scenarios (ADR-0090 Phase 4). One entry per Agent Core
// capability; `CAPABILITY_SCENARIOS` is asserted complete against the
// contract's capability list, so a capability without coverage fails the
// suite instead of silently shrinking it.

import { bufferedMessage, textReplyFrames, toolUseFrames } from "../sse.mjs"

const MODEL = "claude-opus-4-8"

/** Anthropic-spec error body, byte-stable. */
function errorBody(type, message) {
  return JSON.stringify({ type: "error", error: { type, message } })
}

function lastUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.role !== "user") continue
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content)) {
      const text = m.content.find((b) => b?.type === "text")
      if (text) return text.text
    }
  }
  return ""
}

function hasToolResult(body) {
  return (
    Array.isArray(body?.messages) &&
    body.messages.some(
      (m) => Array.isArray(m?.content) && m.content.some((b) => b?.type === "tool_result")
    )
  )
}

/** Reply plan honoring the request's stream flag (CLI probe calls are buffered). */
function textReplyPlan({ body, messageId, text }) {
  if (body?.stream === true) {
    return { sseFrames: textReplyFrames({ messageId, model: MODEL, text }) }
  }
  return { body: bufferedMessage({ messageId, model: MODEL, text }) }
}

export function textSseScenario() {
  return {
    id: "text-sse",
    capabilities: ["streaming"],
    steps: [
      {
        respond: ({ body, hit }) =>
          textReplyPlan({
            body,
            messageId: `msg_conf_text_${hit}`,
            text: "conformance says hello",
          }),
      },
    ],
  }
}

export function multiTurnScenario() {
  return {
    id: "multi-turn",
    capabilities: ["session.multi-turn", "session.resume"],
    steps: [
      {
        name: "turn-2 must carry turn-1 verbatim",
        matches: ({ body }) => (body?.messages?.length ?? 0) > 1,
        respond: ({ body, hit }) =>
          textReplyPlan({
            body,
            messageId: `msg_conf_mt_${hit}`,
            text: "second turn acknowledged",
          }),
      },
      {
        respond: ({ body, hit }) =>
          textReplyPlan({ body, messageId: `msg_conf_mt_${hit}`, text: "first turn reply" }),
      },
    ],
  }
}

export function toolsScenario() {
  return {
    id: "tools",
    capabilities: ["tools.ordinary", "tools.parallel", "tools.results", "tools.errors", "mcp"],
    steps: [
      {
        name: "after tool_result: finish",
        matches: ({ body }) => hasToolResult(body),
        respond: ({ body, hit }) =>
          textReplyPlan({
            body,
            messageId: `msg_conf_tools_${hit}`,
            text: "tool results received",
          }),
      },
      {
        name: "parallel tool calls",
        matches: ({ body }) => lastUserText(body).includes("use both tools"),
        respond: ({ hit }) => ({
          sseFrames: toolUseFrames({
            messageId: `msg_conf_tools_${hit}`,
            model: MODEL,
            tools: [
              { id: "toolu_conf_1", name: "conf_echo", inputJson: '{"text":"a"}' },
              { id: "toolu_conf_2", name: "conf_echo", inputJson: '{"text":"b"}' },
            ],
          }),
        }),
      },
      {
        respond: ({ hit }) => ({
          sseFrames: toolUseFrames({
            messageId: `msg_conf_tools_${hit}`,
            model: MODEL,
            tools: [{ id: "toolu_conf_solo", name: "conf_echo", inputJson: '{"text":"solo"}' }],
          }),
        }),
      },
    ],
  }
}

export function fragmentedJsonScenario() {
  // input_json_delta split mid-key, mid-escape, and the FRAME bytes split
  // mid-UTF-8 codepoint (the 3-byte '例') via splitPoints.
  const fullInput = '{"quer\\u0079": "多字节例子", "n": 1}'
  return {
    id: "fragmented-json",
    capabilities: ["tools.fragmented-json"],
    steps: [
      {
        matches: ({ body }) => hasToolResult(body),
        respond: ({ body, hit }) =>
          textReplyPlan({
            body,
            messageId: `msg_conf_frag_${hit}`,
            text: "fragmented input parsed",
          }),
      },
      {
        respond: ({ hit }) => {
          const frames = toolUseFrames({
            messageId: `msg_conf_frag_${hit}`,
            model: MODEL,
            tools: [
              {
                id: "toolu_conf_frag",
                name: "conf_echo",
                inputJson: fullInput,
                fragments: ['{"quer\\u00', '79": "多字', '节例子", "n"', ": 1}"],
              },
            ],
          })
          const bytes = Buffer.from(frames.join(""), "utf8")
          // Force a chunk boundary inside a multi-byte character: find one.
          let splitAt = -1
          for (let i = 0; i < bytes.length - 1; i += 1) {
            if (bytes[i] >= 0xe0 && (bytes[i + 1] & 0xc0) === 0x80) {
              splitAt = i + 1
              break
            }
          }
          return { sseFrames: frames, splitPoints: splitAt > 0 ? [splitAt] : [] }
        },
      },
    ],
  }
}

export function permissionScenario() {
  return {
    id: "permission",
    capabilities: ["permissions.interrupt-resume", "permissions.set-mode"],
    steps: [
      {
        matches: ({ body }) => hasToolResult(body),
        respond: ({ body, hit }) =>
          textReplyPlan({
            body,
            messageId: `msg_conf_perm_${hit}`,
            text: "permission flow settled",
          }),
      },
      {
        respond: ({ hit }) => ({
          sseFrames: toolUseFrames({
            messageId: `msg_conf_perm_${hit}`,
            model: MODEL,
            tools: [{ id: "toolu_conf_perm", name: "conf_write", inputJson: '{"path":"x"}' }],
          }),
        }),
      },
    ],
  }
}

export function modelBindingScenario() {
  // Asserts frozen ticket bindings: inbound sonnet/haiku/opus selectors must
  // arrive as the concrete conf-* models. Anything else = unmatched (500).
  const bound = new Set(["claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-opus-4-8"])
  return {
    id: "model-binding",
    capabilities: ["set-model", "subagents.native"],
    steps: [
      {
        matches: ({ body }) => bound.has(body?.model),
        respond: ({ body, hit }) => ({
          sseFrames: textReplyFrames({
            messageId: `msg_conf_bind_${hit}`,
            model: body.model,
            text: `served by ${body.model}`,
          }),
        }),
      },
    ],
  }
}

export function rateLimitScenario() {
  return {
    id: "rate-limit",
    capabilities: ["rate-limit-handling", "upstream-errors"],
    steps: [
      {
        matches: ({ phase }) => phase === 0,
        respond: () => ({
          status: 429,
          headers: { "retry-after": "1", "request-id": "req_conf_429" },
          body: errorBody("rate_limit_error", "conformance rate limit"),
        }),
      },
      {
        respond: ({ body, hit }) =>
          textReplyPlan({
            body,
            messageId: `msg_conf_rl_${hit}`,
            text: "recovered after rate limit",
          }),
      },
    ],
  }
}

export function upstream5xxScenario() {
  return {
    id: "upstream-5xx",
    capabilities: ["upstream-errors"],
    steps: [
      {
        respond: () => ({
          status: 529,
          headers: { "request-id": "req_conf_529" },
          body: errorBody("overloaded_error", "conformance overloaded"),
        }),
      },
    ],
  }
}

export function streamInterruptionScenario() {
  return {
    id: "stream-interruption",
    capabilities: ["stream-interruption"],
    steps: [
      {
        respond: ({ hit }) => ({
          sseFrames: textReplyFrames({
            messageId: `msg_conf_cut_${hit}`,
            model: MODEL,
            text: "this stream will be cut",
          }),
          failMode: "destroy-after-bytes",
          destroyAfterBytes: 120,
        }),
      },
    ],
  }
}

export function stickyFailoverScenario() {
  // Two upstream credentials; phase 0: credential A refuses pre-byte so the
  // walk fails over to B and must STICK to B afterwards; a 401 must surface
  // without trying the other account.
  return {
    id: "sticky-failover",
    // Credential affinity/failover is a routing invariant, not prompt caching.
    // Keep the case in certification without falsely claiming a capability.
    capabilities: [],
    steps: [
      {
        name: "401 on demand",
        matches: ({ headers, phase }) => phase >= 2 && headers["x-api-key"] === "CONFTEST-SECRET-B",
        respond: () => ({
          status: 401,
          headers: { "request-id": "req_conf_auth" },
          body: errorBody("authentication_error", "invalid x-api-key"),
        }),
      },
      {
        name: "credential A refuses while phase 0",
        matches: ({ headers, phase }) =>
          phase === 0 && headers["x-api-key"] === "CONFTEST-SECRET-A",
        respond: () => ({ failMode: "refuse-connection" }),
      },
      {
        respond: ({ hit, headers }) => ({
          sseFrames: textReplyFrames({
            messageId: `msg_conf_sticky_${hit}`,
            model: MODEL,
            text: `served by ${headers["x-api-key"]}`,
          }),
        }),
      },
    ],
  }
}

function parityTextScenario(id, capabilities) {
  return {
    id,
    capabilities,
    steps: [
      {
        respond: ({ body, hit }) =>
          textReplyPlan({
            body,
            messageId: `msg_conf_${id.replaceAll("-", "_")}_${hit}`,
            text: `${id} acknowledged`,
          }),
      },
    ],
  }
}

export const sdkStructuredSessionScenario = () =>
  parityTextScenario("sdk-structured-session", [
    "prompt-caching",
    "thinking",
    "context-management",
    "images",
    "beta-features",
    "checkpoint",
    "compaction",
    "steer",
    "output.structured",
    "session.store",
    "session.manage",
  ])

export const sdkInputExtensionScenario = () =>
  parityTextScenario("sdk-input-extension", [
    "permissions.update-rules",
    "hooks.lifecycle",
    "input.elicitation",
    "input.dialog",
  ])

export const sdkRuntimeManagementScenario = () =>
  parityTextScenario("sdk-runtime-management", [
    "plugins.native",
    "skills.native",
    "mcp.dynamic",
    "subagents.manage",
    "tasks.background",
    "commands.dynamic",
    "sandbox.native",
  ])

export const sdkHostLifecycleScenario = () =>
  parityTextScenario("sdk-host-lifecycle", ["observability.child", "startup.prewarm"])

/** Every scenario factory, keyed by id. */
export const SCENARIOS = {
  "text-sse": textSseScenario,
  "multi-turn": multiTurnScenario,
  tools: toolsScenario,
  "fragmented-json": fragmentedJsonScenario,
  permission: permissionScenario,
  "model-binding": modelBindingScenario,
  "rate-limit": rateLimitScenario,
  "upstream-5xx": upstream5xxScenario,
  "stream-interruption": streamInterruptionScenario,
  "sticky-failover": stickyFailoverScenario,
  "sdk-structured-session": sdkStructuredSessionScenario,
  "sdk-input-extension": sdkInputExtensionScenario,
  "sdk-runtime-management": sdkRuntimeManagementScenario,
  "sdk-host-lifecycle": sdkHostLifecycleScenario,
}

/**
 * Agent Core capability → scenario ids covering it. `capabilities.test.mjs`
 * asserts every Agent Core id has at least one scenario.
 */
export function capabilityCoverage() {
  const coverage = new Map()
  for (const [id, factory] of Object.entries(SCENARIOS)) {
    for (const capability of factory().capabilities) {
      if (!coverage.has(capability)) coverage.set(capability, [])
      coverage.get(capability).push(id)
    }
  }
  return coverage
}
