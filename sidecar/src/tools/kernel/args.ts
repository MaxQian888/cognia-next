import { z } from "zod"

/** A JSON Schema object, as MCP `tools/list` carries it. */
export type JsonSchemaObject = Record<string, unknown> & { type: "object" }

export type ParsedToolArgs = { ok: true; value: unknown } | { ok: false; message: string }

type ZodInput = { safeParse?: unknown }

/**
 * The one place a builtin tool's zod raw shape is turned into JSON Schema, and
 * the one place raw caller arguments are validated against it.
 *
 * Lives in the tool kernel rather than beside its first caller because it
 * has several — the MCP bridge (`cognia-tool-bridge.mjs`), the `run_code`
 * broker (`applyToolPresentation`) — and each rail that grew its
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
export function toolInputJsonSchema(inputSchema: unknown): JsonSchemaObject {
  if (!inputSchema || typeof inputSchema !== "object") {
    return { type: "object", properties: {} }
  }
  try {
    const object =
      typeof (inputSchema as ZodInput).safeParse === "function"
        ? (inputSchema as z.ZodType)
        : z.object(inputSchema as z.ZodRawShape)
    const schema = z.toJSONSchema(object, { io: "input", unrepresentable: "any" }) as
      Record<string, unknown> | null | undefined
    // MCP requires an object schema at the top level.
    if (!schema || schema.type !== "object") return { type: "object", properties: {} }
    return schema as JsonSchemaObject
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
 */
export function parseToolArgs(inputSchema: unknown, args: unknown): ParsedToolArgs {
  const input = args ?? {}
  if (!inputSchema || typeof inputSchema !== "object") return { ok: true, value: input }
  let object: z.ZodType
  try {
    object =
      typeof (inputSchema as ZodInput).safeParse === "function"
        ? (inputSchema as z.ZodType)
        : z.object(inputSchema as z.ZodRawShape)
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
