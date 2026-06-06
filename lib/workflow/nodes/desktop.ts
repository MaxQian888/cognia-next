/**
 * Desktop UI automation node executors. Each wraps a method on the
 * `desktop` client from `lib/automation/client.ts`, tagging every call with
 * `surface: "workflow"` so the Rust permission gate evaluates against the
 * workflow-surface policy.
 *
 * The executors are intentionally thin — the heavy lifting (permission
 * gating, audit logging, COM apartment) lives in Rust. A failed call
 * surfaces as a thrown error; the orchestrator records it as a failed step
 * via the existing event log machinery.
 *
 * `typeVersion: 1` everywhere — bump per-kind if the input/output shape
 * changes in a future revision.
 */

import { desktop } from "@/lib/automation/client"
import { registerNodeExecutor } from "./registry"
import {
  type ClickTarget,
  elementRef as makeElementRef,
  type ElementRef,
  type EventKind,
  type ImageFormat,
  keyChord as makeKeyChord,
  type Locator,
  type PatternKind,
} from "@/lib/automation/types"
import type { StepExecutionContext } from "@/types/workflow/visual"

// ─────────────────────────────────────────────────────────────────────────────
// Param helpers — every executor pulls its config from `ctx.params`. We use
// permissive `Record<string, unknown>` shapes because the Zod schemas in
// `params-schemas.ts` are `z.object({}).passthrough()` for desktop nodes
// (validation is in the per-kind inspector forms, M2). These helpers do the
// minimum type-narrowing the executor needs.
// ─────────────────────────────────────────────────────────────────────────────

function str(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === "string" ? v : undefined
}

function num(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key]
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function obj(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = params[key]
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function parseElementRef(params: Record<string, unknown>, key: string): ElementRef | undefined {
  const raw = params[key]
  if (typeof raw === "string") return makeElementRef(raw)
  if (Array.isArray(raw) && typeof raw[0] === "string") return makeElementRef(raw[0])
  return undefined
}

function parseLocator(params: Record<string, unknown>): Locator {
  const loc = obj(params, "locator") ?? params
  return {
    name: typeof loc.name === "string" ? (loc.name as string) : undefined,
    nameContains: typeof loc.nameContains === "string" ? (loc.nameContains as string) : undefined,
    automationId: typeof loc.automationId === "string" ? (loc.automationId as string) : undefined,
    controlType: typeof loc.controlType === "string" ? (loc.controlType as string) : undefined,
    className: typeof loc.className === "string" ? (loc.className as string) : undefined,
    processId:
      typeof loc.processId === "number" && Number.isFinite(loc.processId)
        ? (loc.processId as number)
        : undefined,
    processName: typeof loc.processName === "string" ? (loc.processName as string) : undefined,
    windowTitleContains:
      typeof loc.windowTitleContains === "string" ? (loc.windowTitleContains as string) : undefined,
    depth:
      typeof loc.depth === "number" && Number.isFinite(loc.depth)
        ? (loc.depth as number)
        : undefined,
  }
}

function callCtx(params: Record<string, unknown>) {
  // ADR-0020 remote-target — a per-node `target: { connectionId }` routes this
  // node's desktop action to a cua sandbox; absent / empty = local host.
  const target = obj(params, "target")
  const sandboxConnectionId = target ? str(target, "connectionId") : undefined
  return {
    surface: "workflow" as const,
    processName: str(params, "processName"),
    windowTitle: str(params, "windowTitle"),
    sandboxConnectionId: sandboxConnectionId || undefined,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Executors
// ─────────────────────────────────────────────────────────────────────────────

registerNodeExecutor({
  kind: "action.desktop.screenshot",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const params = ctx.params
    const format = (str(params, "format") as ImageFormat | undefined) ?? "png"
    const region = obj(params, "region")
    const opts: {
      format: ImageFormat
      region?: { x: number; y: number; width: number; height: number }
    } = {
      format,
    }
    if (region) {
      const x = num(region, "x") ?? 0
      const y = num(region, "y") ?? 0
      const w = num(region, "width") ?? 0
      const h = num(region, "height") ?? 0
      opts.region = { x, y, width: w, height: h }
    }
    const shot = await desktop.screenshot(opts, callCtx(params))
    return { output: shot }
  },
})

registerNodeExecutor({
  kind: "action.desktop.findElement",
  typeVersion: 1,
  execute: async (ctx) => {
    const locator = parseLocator(ctx.params)
    const ref = await desktop.find(locator, callCtx(ctx.params))
    return { output: { elementRef: ref, locator } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.readTree",
  typeVersion: 1,
  execute: async (ctx) => {
    const root = parseElementRef(ctx.params, "root")
    const maxDepth = num(ctx.params, "maxDepth") ?? 2
    const tree = await desktop.readTree(root ?? null, { maxDepth }, callCtx(ctx.params))
    return { output: { tree } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.click",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params
    const elementRef = parseElementRef(params, "elementRef")
    let target: ClickTarget
    if (elementRef) {
      target = { kind: "element", elementRef }
    } else {
      const x = num(params, "x") ?? 0
      const y = num(params, "y") ?? 0
      target = { kind: "point", x, y }
    }
    const button = (str(params, "button") as "left" | "right" | "middle" | undefined) ?? "left"
    const double = params.double === true
    await desktop.click(target, { button, double }, callCtx(params))
    return { output: { target } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.type",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params
    const text = str(params, "text") ?? ""
    const delayMs = num(params, "delayMs")
    const target = parseElementRef(params, "target")
    await desktop.type(text, { delayMs, target }, callCtx(params))
    return { output: { text } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.keys",
  typeVersion: 1,
  execute: async (ctx) => {
    const chord = str(ctx.params, "chord") ?? ""
    if (!chord) {
      throw new Error("action.desktop.keys requires a non-empty 'chord' (e.g. 'ctrl+shift+t')")
    }
    await desktop.keys(makeKeyChord(chord), callCtx(ctx.params))
    return { output: { chord } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.paste",
  typeVersion: 1,
  execute: async (ctx) => {
    const text = str(ctx.params, "text") ?? ""
    if (!text) {
      throw new Error("action.desktop.paste requires a non-empty 'text'")
    }
    await desktop.paste(text, callCtx(ctx.params))
    return { output: { pasted: true, chars: text.length } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.launchApp",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params
    const app = str(params, "app") ?? ""
    if (!app) {
      throw new Error("action.desktop.launchApp requires a non-empty 'app' (path or name)")
    }
    const action = str(params, "action") === "focus" ? ("focus" as const) : ("launch" as const)
    await desktop.launchApp(app, action, callCtx(params))
    return { output: { app, action } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.invokePattern",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params
    const target = parseElementRef(params, "target")
    if (!target) {
      throw new Error("action.desktop.invokePattern requires a 'target' element ref")
    }
    const pattern = (str(params, "pattern") as PatternKind | undefined) ?? "invoke"
    const patternArgs = obj(params, "args") ?? {}
    const result = await desktop.invokePattern(target, pattern, patternArgs, callCtx(params))
    return { output: { pattern, result } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.windowFocus",
  typeVersion: 1,
  execute: async (ctx) => {
    const target = parseElementRef(ctx.params, "target")
    if (!target) {
      throw new Error("action.desktop.windowFocus requires a 'target' element ref")
    }
    await desktop.windowOp(target, { kind: "focus" }, callCtx(ctx.params))
    return { output: { focused: target } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.windowClose",
  typeVersion: 1,
  execute: async (ctx) => {
    const target = parseElementRef(ctx.params, "target")
    if (!target) {
      throw new Error("action.desktop.windowClose requires a 'target' element ref")
    }
    await desktop.windowOp(target, { kind: "close" }, callCtx(ctx.params))
    return { output: { closed: target } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.windowResize",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params
    const target = parseElementRef(params, "target")
    if (!target) {
      throw new Error("action.desktop.windowResize requires a 'target' element ref")
    }
    const rect = obj(params, "rect")
    if (!rect) {
      throw new Error("action.desktop.windowResize requires a 'rect' with x/y/width/height")
    }
    const x = num(rect, "x") ?? 0
    const y = num(rect, "y") ?? 0
    const width = num(rect, "width") ?? 0
    const height = num(rect, "height") ?? 0
    await desktop.windowOp(
      target,
      { kind: "resize", rect: { x, y, width, height } },
      callCtx(params)
    )
    return { output: { resized: target, rect: { x, y, width, height } } }
  },
})

registerNodeExecutor({
  kind: "action.desktop.wait",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params
    const locator = parseLocator(params)
    const timeoutMs = num(params, "timeoutMs") ?? 10_000
    const pollMs = num(params, "pollMs") ?? 250
    const mode = (str(params, "mode") as "appear" | "disappear" | undefined) ?? "appear"
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (ctx.signal.aborted) throw new Error("action.desktop.wait aborted")
      const ref = await desktop.find(locator, callCtx(params))
      const present = ref !== null
      if ((mode === "appear" && present) || (mode === "disappear" && !present)) {
        return { output: { elementRef: ref, present } }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
    throw new Error(`action.desktop.wait timed out waiting for ${mode}`)
  },
})

registerNodeExecutor({
  kind: "trigger.desktop.event",
  typeVersion: 1,
  execute: async (ctx) => {
    // Triggers are typically registered via the trigger bridge (Rust side),
    // not executed inline. This handler exists so the node round-trips when
    // a workflow runs in "manual + trigger.desktop.event" mode — it simply
    // passes through the trigger payload. M2 wires real UIA-event firing.
    const kinds = (Array.isArray(ctx.params.kinds) ? ctx.params.kinds : []) as EventKind[]
    return { output: { kinds, firedAt: ctx.trigger.originAt, payload: ctx.trigger.payload } }
  },
})
