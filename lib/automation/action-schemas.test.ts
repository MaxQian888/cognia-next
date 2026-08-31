/**
 * Cross-language parity for the Computer Use action contract.
 *
 * Rust owns this contract (`crates/cognia-automation/src/automation/session.rs`),
 * and nothing in the build crosses the language boundary: a new `UiAction`
 * variant on the Rust side would leave the model-facing JSON Schema silently
 * one variant short, which is the failure mode that let the whole vocabulary go
 * missing in the first place. These tests read the Rust source and compare.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  actionRequestSchema,
  actionStrategySchema,
  actionTargetSchema,
  toToolSchema,
  uiActionSchema,
} from "./action-schemas"

const SESSION_RS = join(
  __dirname,
  "..",
  "..",
  "crates",
  "cognia-automation",
  "src",
  "automation",
  "session.rs"
)

function rustSource(): string {
  return readFileSync(SESSION_RS, "utf8")
}

/** PascalCase -> camelCase, matching `#[serde(rename_all = "camelCase")]`. */
function camel(variant: string): string {
  return variant.charAt(0).toLowerCase() + variant.slice(1)
}

/**
 * Pull the variant names out of `pub enum <name> { ... }`. Only top-level
 * variants count, so we track brace depth and read identifiers at depth 1.
 */
function rustEnumVariants(source: string, name: string): string[] {
  const start = source.indexOf(`pub enum ${name} {`)
  if (start === -1) throw new Error(`enum ${name} not found in session.rs`)
  let depth = 0
  let i = source.indexOf("{", start)
  const body: string[] = []
  let line = ""
  for (; i < source.length; i++) {
    const ch = source[i]
    if (ch === "{") {
      depth++
      if (depth === 1) continue
    } else if (ch === "}") {
      depth--
      if (depth === 0) break
    }
    if (depth === 1) {
      if (ch === "\n") {
        body.push(line)
        line = ""
      } else {
        line += ch
      }
    }
  }
  body.push(line)
  return body
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("#["))
    .map((l) => /^([A-Z][A-Za-z0-9]*)\s*[,{(]?/.exec(l)?.[1])
    .filter((v): v is string => Boolean(v))
}

/** Discriminator literals of a zod discriminated union, in declaration order. */
function zodVariants(schema: typeof uiActionSchema | typeof actionTargetSchema): string[] {
  return schema.options.map((option) => {
    const kind = (option as unknown as { shape: { kind: { value: string } } }).shape.kind
    return kind.value
  })
}

describe("action schema ⇄ Rust parity", () => {
  it("covers exactly the Rust UiAction variants", () => {
    const rust = rustEnumVariants(rustSource(), "UiAction").map(camel)
    expect(zodVariants(uiActionSchema).sort()).toEqual(rust.sort())
  })

  it("covers exactly the Rust ActionTarget variants", () => {
    const rust = rustEnumVariants(rustSource(), "ActionTarget").map(camel)
    expect(zodVariants(actionTargetSchema).sort()).toEqual(rust.sort())
  })

  it("covers exactly the Rust ActionStrategy variants", () => {
    const rust = rustEnumVariants(rustSource(), "ActionStrategy").map(camel)
    expect([...actionStrategySchema.options].sort()).toEqual(rust.sort())
  })

  it("discriminates on `kind`, the serde tag Rust declares", () => {
    // `#[serde(tag = "kind", ...)]` — an internally tagged enum. If Rust ever
    // moved to an externally tagged representation the payload shape would
    // change entirely, so pin the tag rather than assume it.
    const source = rustSource()
    const uiActionDecl = source.slice(
      source.lastIndexOf("#[derive", source.indexOf("pub enum UiAction {")),
      source.indexOf("pub enum UiAction {")
    )
    expect(uiActionDecl).toContain('tag = "kind"')
    expect(uiActionDecl).toContain('rename_all = "camelCase"')
  })
})

describe("rendered tool schema", () => {
  it("renders the action vocabulary as a oneOf the model can read", () => {
    const schema = toToolSchema(actionRequestSchema) as {
      properties: { action: { oneOf?: unknown[] }; turnToken: { description?: string } }
      required: string[]
    }
    // The whole point of this module: the action must NOT be an opaque object.
    expect(Array.isArray(schema.properties.action.oneOf)).toBe(true)
    expect(schema.properties.action.oneOf).toHaveLength(uiActionSchema.options.length)
    expect(schema.required).toEqual(
      expect.arrayContaining(["turnToken", "target", "action", "strategy"])
    )
    // `turnToken` is single-use; the model can only learn that from prose.
    expect(schema.properties.turnToken.description).toMatch(/single-use/i)
  })

  it("accepts a well-formed element-targeted request", () => {
    const parsed = actionRequestSchema.safeParse({
      turnToken: "tok",
      target: {
        kind: "element",
        handle: {
          sessionId: "s",
          lineageId: "l",
          revision: 3,
          index: 0,
          fingerprint: "abc",
        },
      },
      action: { kind: "click", count: 2 },
      strategy: "auto",
    })
    expect(parsed.success).toBe(true)
  })

  it("rejects a pixel target that omits the screenshot dimensions", () => {
    // Those dimensions are the stale-frame guard — without them the backend
    // cannot tell that the point was read off a frame that no longer matches.
    const parsed = actionRequestSchema.safeParse({
      turnToken: "tok",
      target: {
        kind: "pixel",
        target: { sessionId: "s", lineageId: "l", revision: 1, point: { x: 10, y: 20 } },
      },
      action: { kind: "typeText", text: "hi" },
      strategy: "pixel",
    })
    expect(parsed.success).toBe(false)
  })

  it("rejects an unknown action kind", () => {
    const parsed = uiActionSchema.safeParse({ kind: "teleport" })
    expect(parsed.success).toBe(false)
  })
})
