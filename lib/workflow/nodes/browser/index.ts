/**
 * Agent-browser action nodes (ADR-0055 / 0072 / 0085): `action.browser.{open,
 * snapshot,readPage,act,fillForm,waitFor,screenshot,diagnostics,replayFlow}`.
 *
 * Until these existed the only web reach a graph had was `io.http` (no page,
 * no JS) and `io.webClone` (a snapshot on disk). The agent's browser tools
 * belong to the agent, so driving a page cost an LLM turn per action.
 *
 * The engine comes from `./engine`, which owns a run-scoped session rather
 * than borrowing whichever engine a React pane happened to bind. See that
 * module for why.
 *
 * Five ops with a real seam are deliberately absent:
 *
 *  - `evaluate`. Arbitrary JS against a `public` page, in a run with nobody
 *    watching, is the `computer-use` surface with its gate removed. The
 *    plugin's gate is a model plus a human reading the transcript, and a DAG
 *    has neither.
 *  - `createPage`, `drag`, `handleDialog`, `setFiles`, `downloads`. All five
 *    throw on the embedded engine (`EMBEDDED_UNSUPPORTED_FEATURES`), and the
 *    remote backend is off by default, so a node for them would work on one
 *    backend out of two. That is how dormant features ship.
 */

import type { BrowserEngine } from "@/lib/browser/agent-engine"
import type { BrowserActionResult } from "@/lib/browser/protocol"
import type { StepExecutionContext } from "@/types/workflow/visual"
import { registerNodeExecutor } from "../registry"
import { nonRetryable } from "../shared/executor-support"
import { assertBrowserUrlAllowed, resolveRunBrowserEngine } from "./engine"

/** A page's accessibility tree is unbounded. A step output is not. */
const SNAPSHOT_DEFAULT_MAX_NODES = 200
const SNAPSHOT_CEILING_MAX_NODES = 2000
const DIAGNOSTIC_DEFAULT_LIMIT = 50

const ACT_ACTIONS = [
  "click",
  "double_click",
  "type",
  "fill",
  "select",
  "hover",
  "focus",
  "key",
  "scroll",
] as const
type ActAction = (typeof ACT_ACTIONS)[number]

function params(ctx: StepExecutionContext): Record<string, unknown> {
  return ctx.params as Record<string, unknown>
}

function str(p: Record<string, unknown>, key: string): string | undefined {
  const v = p[key]
  if (typeof v !== "string") return undefined
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function int(p: Record<string, unknown>, key: string): number | undefined {
  const v = p[key]
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : undefined
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * The engine for a step that operates on the page a previous step opened.
 *
 * It asks the engine where it is and re-checks the authorization, because a
 * page can navigate itself. Without this, one authorized `open` would license
 * every later action on whatever the page became.
 */
async function engineOnCurrentPage(
  ctx: StepExecutionContext,
  kind: string
): Promise<{ engine: BrowserEngine; url: string; title: string }> {
  const seed = str(params(ctx), "url")
  const resolved = await resolveRunBrowserEngine(ctx, seed ?? "http://localhost", kind)
  const page = await resolved.engine.getPage()
  assertBrowserUrlAllowed(page.url, kind)
  return { engine: resolved.engine, url: page.url, title: page.title }
}

function actionResultOutput(result: BrowserActionResult | void): Record<string, unknown> {
  if (!result) return { ok: true, error: null, generation: undefined }
  return { ok: result.ok, error: result.error, generation: result.generation }
}

registerNodeExecutor({
  kind: "action.browser.open",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const url = str(params(ctx), "url")
    if (!url) throw nonRetryable("action.browser.open requires 'url'")
    const { engine, backend, tier } = await resolveRunBrowserEngine(ctx, url, "action.browser.open")

    await engine.navigate(url)
    const timeoutMs = int(params(ctx), "timeoutMs")
    await engine.waitForLoad(timeoutMs ? { timeoutMs } : undefined)

    // Re-checked on the LANDED url, not the requested one. A redirect off the
    // granted domain fails the step rather than licensing whatever it reached.
    const page = await engine.getPage()
    assertBrowserUrlAllowed(page.url, "action.browser.open")

    return {
      output: {
        url: page.url,
        title: page.title,
        requestedUrl: url,
        redirected: page.url !== url,
        backend,
        tier,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.browser.snapshot",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { engine, url, title } = await engineOnCurrentPage(ctx, "action.browser.snapshot")
    const maxNodes = clamp(
      int(p, "maxNodes") ?? SNAPSHOT_DEFAULT_MAX_NODES,
      1,
      SNAPSHOT_CEILING_MAX_NODES
    )
    const snapshot = await engine.snapshot({
      includeText: p.includeText === true,
    })
    const nodes = snapshot.nodes.slice(0, maxNodes)
    return {
      output: {
        url,
        title,
        generation: snapshot.generation,
        nodes,
        nodeCount: nodes.length,
        totalNodeCount: snapshot.nodes.length,
        truncated: snapshot.nodes.length > nodes.length,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.browser.readPage",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { engine, url, title } = await engineOnCurrentPage(ctx, "action.browser.readPage")
    const maxNodes = clamp(
      int(p, "maxNodes") ?? SNAPSHOT_DEFAULT_MAX_NODES,
      1,
      SNAPSHOT_CEILING_MAX_NODES
    )
    const snapshot = await engine.snapshot({ includeText: true })
    const nodes = snapshot.nodes.slice(0, maxNodes)
    // A snapshot node has no `text` field. `includeText` surfaces salient
    // non-interactive content as extra nodes, whose readable content is their
    // accessible `name` plus a form control's `value`.
    const text = nodes
      .map((node) => [node.name, node.value].filter(Boolean).join(": "))
      .filter((line) => line.trim().length > 0)
      .join("\n")
    return {
      output: {
        url,
        title,
        text,
        byteLength: text.length,
        nodeCount: nodes.length,
        truncated: snapshot.nodes.length > nodes.length,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.browser.act",
  typeVersion: 1,
  // A retry re-clicks. Half of these actions are not idempotent on a real page.
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const action = str(p, "action") as ActAction | undefined
    if (!action || !(ACT_ACTIONS as readonly string[]).includes(action)) {
      throw nonRetryable(`action.browser.act: 'action' must be one of ${ACT_ACTIONS.join(", ")}`)
    }
    const { engine, url } = await engineOnCurrentPage(ctx, "action.browser.act")
    const ref = str(p, "ref")
    const value = typeof p.value === "string" ? p.value : undefined

    let result: BrowserActionResult | void
    if (action === "key") {
      const key = value ?? str(p, "key")
      if (!key) throw nonRetryable("action.browser.act: a key action requires 'value'")
      result = await engine.pressKey(key, ref)
    } else if (action === "scroll") {
      result = await engine.scroll({
        reference: ref,
        direction: str(p, "direction") as "up" | "down" | "left" | "right" | "top" | "bottom",
        amount: int(p, "amount"),
      })
    } else {
      if (!ref) throw nonRetryable(`action.browser.act: '${action}' requires 'ref'`)
      result = await engine.act(ref, action, value === undefined ? {} : { value })
    }

    return { output: { url, action, ref, ...actionResultOutput(result) } }
  },
})

registerNodeExecutor({
  kind: "action.browser.fillForm",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const rawFields = Array.isArray(p.fields) ? (p.fields as unknown[]) : []
    if (rawFields.length === 0) throw nonRetryable("action.browser.fillForm requires 'fields'")
    const { engine, url } = await engineOnCurrentPage(ctx, "action.browser.fillForm")

    const completed: string[] = []
    for (const [index, raw] of rawFields.entries()) {
      const field = raw as { ref?: unknown; value?: unknown; credentialRef?: unknown }
      const ref = typeof field.ref === "string" ? field.ref.trim() : ""
      if (!ref) throw nonRetryable(`action.browser.fillForm: field ${index} has no 'ref'`)

      let value = typeof field.value === "string" ? field.value : ""
      if (typeof field.credentialRef === "string" && field.credentialRef.length > 0) {
        const secret = await ctx.resolveSecret(field.credentialRef)
        // A field bound to a credential that does not resolve must fail loudly.
        // Typing an empty string into a password box looks like it worked.
        if (secret === undefined) {
          throw nonRetryable(
            `action.browser.fillForm: field ${index} names credential ` +
              `'${field.credentialRef}', which this run cannot resolve`
          )
        }
        value = secret
      }

      const result = await engine.act(ref, "fill", { value })
      // Ordered and non-transactional, like the agent tool it mirrors: report
      // where it stopped rather than pretending the form is in a known state.
      if (result && result.ok === false) {
        return {
          output: {
            url,
            completed,
            completedCount: completed.length,
            failedIndex: index,
            failedRef: ref,
            error: result.error ?? null,
            ok: false,
          },
        }
      }
      completed.push(ref)
    }

    return {
      output: { url, completed, completedCount: completed.length, failedIndex: null, ok: true },
    }
  },
})

registerNodeExecutor({
  kind: "action.browser.waitFor",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const text = str(p, "text")
    const selector = str(p, "selector")
    const networkIdle = p.networkIdle === true
    const chosen = [text, selector, networkIdle ? "networkIdle" : undefined].filter(Boolean)
    if (chosen.length !== 1) {
      throw nonRetryable(
        "action.browser.waitFor takes exactly one of 'text', 'selector' or 'networkIdle'"
      )
    }

    const { engine, url } = await engineOnCurrentPage(ctx, "action.browser.waitFor")
    const timeoutMs = int(p, "timeoutMs")
    const mode: "appear" | "disappear" = p.mode === "disappear" ? "disappear" : "appear"
    const opts = timeoutMs ? { mode, timeoutMs } : { mode }

    const result = text
      ? await engine.waitForText(text, opts)
      : selector
        ? await engine.waitForSelector(selector, opts)
        : await engine.waitForNetworkIdle(timeoutMs ? { timeoutMs } : undefined)

    const met = result.ok && !result.timedOut
    if (!met && p.failOnTimeout !== false) {
      throw nonRetryable(
        `action.browser.waitFor: the condition was not met within the timeout on ${url}`
      )
    }
    return { output: { url, met, waitedFor: text ?? selector ?? "networkIdle", mode } }
  },
})

registerNodeExecutor({
  kind: "action.browser.screenshot",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { engine, url, title } = await engineOnCurrentPage(ctx, "action.browser.screenshot")
    const scope =
      p.scope === "fullPage" ? "fullPage" : p.scope === "element" ? "element" : "viewport"
    const ref = str(p, "ref")
    if (scope === "element" && !ref) {
      throw nonRetryable("action.browser.screenshot: an element scope requires 'ref'")
    }
    const shot = await engine.screenshot(ref ? { scope, ref } : { scope })
    return {
      output: {
        url,
        title,
        scope,
        // A rendered page is a large payload and `appendEvent` writes a step
        // output verbatim, so the bytes ride only when the author asks. The
        // size and dimensions are always reported, so a flow can branch on
        // them without carrying the image.
        imageBase64: p.includeImage === true ? shot.bytes : undefined,
        mimeType: "image/png",
        byteLength: shot.bytes.length,
        width: shot.width,
        height: shot.height,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.browser.diagnostics",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const { engine, url } = await engineOnCurrentPage(ctx, "action.browser.diagnostics")
    const limit = clamp(int(p, "limit") ?? DIAGNOSTIC_DEFAULT_LIMIT, 1, 500)
    const wantConsole = p.include !== "network"
    const wantNetwork = p.include !== "console"

    const [consoleEntries, networkEntries] = await Promise.all([
      wantConsole ? engine.readConsole().catch(() => []) : Promise.resolve([]),
      wantNetwork ? engine.readNetwork().catch(() => []) : Promise.resolve([]),
    ])
    const errorsOnly = p.errorsOnly === true
    const consoleRows = (
      errorsOnly
        ? consoleEntries.filter((e) => (e as { level?: string }).level === "error")
        : consoleEntries
    ).slice(-limit)

    return {
      output: {
        url,
        console: consoleRows,
        consoleCount: consoleRows.length,
        network: networkEntries.slice(-limit),
        networkCount: Math.min(networkEntries.length, limit),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.browser.replayFlow",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const p = params(ctx)
    const recordingId = str(p, "recordingId")
    if (!recordingId) throw nonRetryable("action.browser.replayFlow requires 'recordingId'")

    const [{ getRecording }, { replayFlow }] = await Promise.all([
      import("@/lib/db/browser-recordings"),
      import("@/lib/browser/recording/replayer"),
    ])
    const recording = await getRecording(recordingId)
    if (!recording) {
      throw nonRetryable(`action.browser.replayFlow: no recording ${recordingId}`)
    }

    // The base origin AND every navigate step, not just the first. A recording
    // is a script someone saved earlier, and the grants may have narrowed since.
    assertBrowserUrlAllowed(recording.baseUrl, "action.browser.replayFlow")
    for (const step of recording.steps) {
      if (step.act === "navigate") {
        assertBrowserUrlAllowed(step.url, "action.browser.replayFlow")
      }
    }

    const { engine } = await resolveRunBrowserEngine(
      ctx,
      recording.baseUrl,
      "action.browser.replayFlow"
    )
    const secrets: Record<string, string> = {}
    for (const [slot, refId] of Object.entries(ctx.credentialRefs ?? {})) {
      const value = await ctx.resolveSecret(refId)
      if (value !== undefined) secrets[slot] = value
    }

    const result = await replayFlow(recording, engine, { secrets, signal: ctx.signal })
    const failedIndex = result.steps.findIndex((step) => !step.ok)
    return {
      output: {
        recordingId,
        ok: result.ok,
        stepCount: result.steps.length,
        completedCount: result.steps.filter((step) => step.ok).length,
        failedStepIndex: failedIndex === -1 ? null : failedIndex,
        error: failedIndex === -1 ? null : result.steps[failedIndex].error,
      },
    }
  },
})
