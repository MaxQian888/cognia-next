import { z } from "zod"

/**
 * The one place a builtin tool's zod raw shape is turned into JSON Schema, and
 * the one place raw caller arguments are validated against it.
 *
 * Lives under `builtin-tools/` rather than beside its first caller because it
 * has three of them now — the MCP bridge (`cognia-tool-bridge.mjs`), the
 * `run_code` broker (`builtin-tools/index.mjs`) — and each rail that grew its
 * own copy of "just call the handler" reintroduced the same defect: every
 * `.default()`, `.min()`, `.max()` and `.enum()` silently inert. Keeping the
 * conversion and the parse together also keeps the schema the model is SHOWN
 * derived from the same definition the handler is validated against.
 */

/**
 * Convert a builtin tool def's zod raw shape into a JSON Schema object, which is
 * what MCP `tools/list` requires. Zod 4 ships the conversion, so the schema the
 * external agent sees is derived from the SAME definition the built-in backend
 * validates against rather than a hand-maintained copy.
 */
export function toolInputJsonSchema(inputSchema) {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { type: "object", properties: {} }
  }
  try {
    const object = typeof inputSchema.safeParse === "function" ? inputSchema : z.object(inputSchema)
    const schema = z.toJSONSchema(object, { io: "input", unrepresentable: "any" })
    // MCP requires an object schema at the top level.
    if (!schema || schema.type !== "object") return { type: "object", properties: {} }
    return schema
  } catch {
    return { type: "object", properties: {} }
  }
}

/**
 * Validate + normalise raw JSON-RPC arguments against a tool's zod shape.
 *
 * The bridge previously called `def.handler(args ?? {}, {})` on whatever the
 * external agent sent, using the zod shape ONLY to advertise a JSON Schema. So
 * on this rail every `.default()`, `.min()`, `.max()` and `.enum()` was inert:
 * `content_search`'s `maxResults` cap vanished (`length >= undefined` is always
 * false), `shell_execute_advanced` ran with no timeout, `start_process` got a
 * `NaN` timeout, and `terminal_repl_read` returned an empty string. The
 * Anthropic and ai-sdk rails both parse; the bridge and the `run_code` broker
 * now do too.
 *
 * Fails OPEN on an unrepresentable schema (same posture as
 * `toolInputJsonSchema`) so a conversion quirk cannot brick a working tool.
 *
 * @returns {{ ok: true, value: unknown } | { ok: false, message: string }}
 */
export function parseToolArgs(inputSchema, args) {
  const input = args ?? {}
  if (!inputSchema || typeof inputSchema !== "object") return { ok: true, value: input }
  let object
  try {
    object = typeof inputSchema.safeParse === "function" ? inputSchema : z.object(inputSchema)
  } catch {
    return { ok: true, value: input }
  }
  const parsed = object.safeParse(input)
  if (parsed.success) return { ok: true, value: parsed.data }
  const detail = parsed.error?.issues
    ?.slice(0, 5)
    .map((i) => `${i.path?.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ")
  return { ok: false, message: detail || "invalid arguments" }
}
