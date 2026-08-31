/**
 * Zod schemas for the model-facing Computer Use contract (ADR-0020,
 * app-session model).
 *
 * These exist because the five app-session tools used to publish
 * `{type:"object"}` for their whole payload: the action vocabulary lived only
 * in TypeScript types, so the model was never told that element handles, the
 * `strategy` switch, or the eight `UiAction` kinds existed. A bare
 * `{type:"object"}` also degrades to `z.unknown()` in the sidecar's
 * `jsonSchemaToZodShape`, so nothing validated the payload either.
 *
 * One zod definition per concept serves three consumers:
 *   1. `z.toJSONSchema(...)` renders `parametersSchema` for the plugin tools.
 *   2. `z.infer<...>` gives `lib/automation/types.ts` its TypeScript types,
 *      so there is no second hand-maintained copy to drift.
 *   3. `action-schemas.test.ts` pins the union against the Rust enum.
 *
 * The authority is still Rust — `crates/cognia-automation/src/automation/
 * session.rs` (`UiAction`, `ActionTarget`, `ActionRequest`) and `types.rs`
 * (`Point`, `MouseButton`, `DragOpts`, `ScrollOpts`, `Locator`). This module
 * mirrors it; the co-located test is what keeps the mirror honest, because no
 * build gate crosses the language boundary.
 *
 * Descriptions are not decoration. They are the only channel through which the
 * model learns protocol rules it cannot infer from shape — that `turnToken` is
 * single-use and comes from the previous `get_app_state`, that pixel targets
 * must restate the screenshot dimensions they were derived from, and that
 * `revision` must be the one the handle was minted against.
 */

import { z } from "zod"

/**
 * Rust `ElementRef(pub String)` / `KeyChord(pub String)` are newtype structs.
 * serde renders a newtype struct transparently, so both cross the wire as a
 * bare JSON string — not as the one-element tuple `lib/automation/types.ts`
 * used to declare. See `element-ref-wire-format` in the Rust tests.
 */
export const elementRefSchema = z
  .string()
  .describe("Opaque backend element reference. Pass it back unchanged.")

export const keyChordSchema = z
  .string()
  .describe('Key chord, e.g. "ctrl+shift+t", "alt+F4", "Enter". Modifier order is irrelevant.')

export const pointSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
  })
  .describe("2D coordinate. The space depends on the enclosing target — see `pixel`.")

export const mouseButtonSchema = z.enum(["left", "right", "middle"])

export const dragOptsSchema = z.object({
  button: mouseButtonSchema.optional(),
  durationMs: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Total move duration in milliseconds (default ~150)."),
  steps: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Interpolated waypoints between start and end (default ~12)."),
})

export const scrollOptsSchema = z.object({
  dx: z.number().int().optional().describe("Positive scrolls right."),
  dy: z.number().int().optional().describe("Positive scrolls down."),
})

export const uiTreeProjectionKindSchema = z.enum(["model", "inspector"])

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export const elementHandleSchema = z
  .object({
    sessionId: z.string(),
    lineageId: z.string(),
    revision: z
      .number()
      .int()
      .min(1)
      .describe("The revision this handle was minted against. A stale revision is refused."),
    index: z.number().int().min(0),
    fingerprint: z.string(),
  })
  .describe(
    "A handle from `get_app_state` / `query_elements` / `expand_element`. Copy it back verbatim."
  )

export const pixelTargetSchema = z
  .object({
    sessionId: z.string(),
    lineageId: z.string(),
    revision: z.number().int().min(1),
    point: pointSchema.describe("Coordinate in the screenshot's own pixel space, top-left origin."),
    screenshotWidth: z
      .number()
      .int()
      .min(1)
      .describe("Width of the screenshot this point was read off."),
    screenshotHeight: z
      .number()
      .int()
      .min(1)
      .describe("Height of the screenshot this point was read off."),
  })
  .describe(
    "Pixel fallback. The dimensions are checked against the revision's surface, so a point " +
      "read off a stale frame is refused instead of silently clicking the wrong place."
  )

export const actionTargetSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("element"), handle: elementHandleSchema }),
    z.object({ kind: z.literal("pixel"), target: pixelTargetSchema }),
  ])
  .describe(
    "Prefer `element`: it survives layout shifts and is delivered through the accessibility " +
      "API. Use `pixel` only when the tree has no node for what you can see."
  )

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const uiActionSchema = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("click"),
      button: mouseButtonSchema.optional(),
      count: z
        .number()
        .int()
        .min(1)
        .max(3)
        .optional()
        .describe("1 = single, 2 = double, 3 = triple. Delivered at the OS double-click cadence."),
    }),
    z.object({
      kind: z.literal("drag"),
      to: pointSchema.describe("Drop point, in the same space as the target."),
      opts: dragOptsSchema.optional(),
    }),
    z.object({ kind: z.literal("scroll"), opts: scrollOptsSchema.optional() }),
    z.object({ kind: z.literal("pressKey"), chord: keyChordSchema }),
    z.object({
      kind: z.literal("typeText"),
      text: z.string().describe("Typed as keystrokes; long text may be pasted instead."),
    }),
    z.object({
      kind: z.literal("setValue"),
      value: z.string().describe("Sets the value directly through the accessibility API."),
    }),
    z.object({
      kind: z.literal("selectText"),
      start: z.number().int().min(0),
      end: z.number().int().min(0),
    }),
    z.object({
      kind: z.literal("secondaryAction"),
      name: z.string().describe("A named accessibility action the element advertises."),
    }),
  ])
  .describe("The action to deliver to the target.")

export const actionStrategySchema = z
  .enum(["semantic", "pixel", "auto"])
  .describe(
    "`semantic` uses the accessibility API, `pixel` synthesises input events, `auto` tries " +
      "semantic first. Prefer `auto` unless you need a specific delivery method."
  )

export const actionRequestSchema = z.object({
  turnToken: z
    .string()
    .describe(
      "Single-use token from the most recent `get_app_state` response. It expires quickly; " +
        "call `get_app_state` again rather than reusing one."
    ),
  target: actionTargetSchema,
  action: uiActionSchema,
  strategy: actionStrategySchema,
})

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const locatorSchema = z
  .object({
    name: z.string().optional(),
    nameContains: z.string().optional(),
    automationId: z.string().optional(),
    controlType: z.string().optional(),
    className: z.string().optional(),
    processId: z.number().int().optional(),
    processName: z.string().optional(),
    windowTitleContains: z.string().optional(),
    depth: z.number().int().min(0).optional(),
    from: elementRefSchema.optional().describe("Restrict the search to this element's subtree."),
  })
  .describe("All present fields must match (AND). An empty locator matches everything.")

export const getAppStateOptionsSchema = z.object({
  disableDiff: z.boolean().optional(),
  allowLaunch: z
    .boolean()
    .optional()
    .describe("Permit launching the app when it is not already running."),
  maxNodes: z.number().int().min(1).optional(),
  maxDepth: z.number().int().min(1).optional(),
  projection: uiTreeProjectionKindSchema.optional(),
})

export const appLocatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bundleId"), bundleId: z.string() }),
  z.object({ kind: z.literal("path"), path: z.string() }),
  z.object({ kind: z.literal("displayName"), displayName: z.string() }),
])

// ---------------------------------------------------------------------------
// Inferred types — `lib/automation/types.ts` re-exports these so the shapes
// are declared exactly once on the TS side.
// ---------------------------------------------------------------------------

export type ElementRef = z.infer<typeof elementRefSchema>
export type KeyChord = z.infer<typeof keyChordSchema>
export type Point = z.infer<typeof pointSchema>
export type MouseButton = z.infer<typeof mouseButtonSchema>
export type DragOpts = z.infer<typeof dragOptsSchema>
export type ScrollOpts = z.infer<typeof scrollOptsSchema>
export type UiTreeProjectionKind = z.infer<typeof uiTreeProjectionKindSchema>
export type ElementHandle = z.infer<typeof elementHandleSchema>
export type PixelTarget = z.infer<typeof pixelTargetSchema>
export type ActionTarget = z.infer<typeof actionTargetSchema>
export type UiAction = z.infer<typeof uiActionSchema>
export type ActionStrategy = z.infer<typeof actionStrategySchema>
export type ActionRequest = z.infer<typeof actionRequestSchema>
export type Locator = z.infer<typeof locatorSchema>
export type GetAppStateOptions = z.infer<typeof getAppStateOptionsSchema>
export type AppLocator = z.infer<typeof appLocatorSchema>

/**
 * Render a zod schema as the plain JSON Schema the plugin tool surface and the
 * sidecar's `jsonSchemaToZodShape` both consume. Draft-7 is what the Anthropic
 * tool API accepts; `io: "input"` renders the pre-parse shape, which is the
 * one the model has to produce.
 */
export function toToolSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    target: "draft-7",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>
}
