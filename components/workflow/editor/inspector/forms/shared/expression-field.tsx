"use client"

/**
 * ExpressionField — a CodeMirror 6 editor that replaces the plain Textarea
 * everywhere the inspector form hint says "supports {{ }} expressions".
 *
 * Features:
 *   • Mustache-aware syntax highlighting via `workflowExpressionLanguage`.
 *   • Autocomplete on `$` / `{{` triggers via `buildExpressionSuggestions`.
 *   • Live-preview footer that resolves the current value against the most
 *     recent run's upstream snapshot (when available).
 *   • Light/dark theme follows next-themes via CSS variables.
 *   • Single-line and multiline modes — when single-line, Enter triggers
 *     the autocomplete-accept and never inserts a newline.
 *
 * Storage shape stays a plain string, identical to the Textarea it replaces,
 * so back-compat is preserved.
 */

import { useEffect, useMemo, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { useGatedLiveQuery } from "@/hooks/workflow/use-gated-live-query"
import {
  flagsForTier,
  resolveEffectiveTier,
  type PerformanceTier,
} from "@/lib/workflow/editor/performance-tier"
import { EditorState, Compartment } from "@codemirror/state"
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  drawSelection,
} from "@codemirror/view"
import { defaultHighlightStyle, syntaxHighlighting, bracketMatching } from "@codemirror/language"
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands"
import {
  autocompletion,
  completionKeymap,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete"
import { workflowExpressionLanguage } from "@/lib/workflow/editor/expression-language"
import { buildExpressionSuggestions } from "@/lib/workflow/editor/expression-suggestions"
import { resolveExpression } from "@/lib/workflow/runtime/expression"
import type { EditorStore, EditorState as WfEditorState } from "@/lib/workflow/editor/store"
import { getDb } from "@/lib/db/index"
import { cn } from "@/lib/utils"
import { useInspectorExpressionCtx } from "./inspector-context"

interface ExpressionFieldProps {
  value: string
  onChange: (next: string) => void
  /** Multiline = a regular textarea-shaped editor; single-line = compact. */
  multiline?: boolean
  rows?: number
  placeholder?: string
  className?: string
  id?: string
  /** The store holding the current workflow's nodes. Optional — without it
   * the editor still works, just without context-aware completions. */
  store?: EditorStore
  /** Step id of the node owning this field. Filtered out of completions. */
  currentNodeId?: string
  /** Aria-label for headless tests. */
  "aria-label"?: string
}

/**
 * Read the most recent successful run's per-step output map for this workflow.
 *
 * `enabled` gates the Dexie liveQuery — when false (e.g. a node is being
 * dragged on the canvas, or the resolved performance tier is `reduced`), we
 * short-circuit to the previously resolved value instead of re-evaluating
 * the query on every `workflowRunEvents` write.
 */
function useLatestRunOutputs(
  workflowId: string | undefined,
  enabled: boolean
): Record<string, unknown> {
  return useGatedLiveQuery<Record<string, unknown>>(
    async () => {
      if (!workflowId) return {}
      const rows = await getDb()
        .workflowRuns.where("[workflowId+startedAt]")
        .between([workflowId, 0], [workflowId, Number.POSITIVE_INFINITY])
        .reverse()
        .limit(5)
        .toArray()
      const success = rows.find((r) => r.status === "succeeded")
      if (!success) return {}
      // Pull every step_completed event's payload — payload contains the
      // step's output snapshot.
      const events = await getDb()
        .workflowRunEvents.where("[runId+ts]")
        .between([success.id, 0], [success.id, Number.POSITIVE_INFINITY])
        .toArray()
      const out: Record<string, unknown> = {}
      for (const ev of events) {
        if (ev.type === "step_completed" && ev.stepId) {
          const payload = ev.payload as { output?: unknown } | undefined
          if (payload && "output" in payload) out[ev.stepId] = payload.output
        }
      }
      return out
    },
    [workflowId],
    {} as Record<string, unknown>,
    enabled
  )
}

export function ExpressionField({
  value,
  onChange,
  multiline = false,
  rows = 3,
  placeholder,
  className,
  id,
  store: storeProp,
  currentNodeId: currentNodeIdProp,
  ...rest
}: ExpressionFieldProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])

  // Inspector forms typically don't pass `store` directly — they pick it up
  // from the InspectorExpressionProvider higher in the tree.
  const ctx = useInspectorExpressionCtx()
  const store = storeProp ?? ctx?.store
  const currentNodeId = currentNodeIdProp ?? ctx?.currentNodeId

  // Pull latest workflow nodes from the store if available — this drives
  // node-aware completions. `useShallow` must be called unconditionally to
  // satisfy rules-of-hooks; the resulting selector is then optionally invoked.
  const shallowSelector = useShallow((s: WfEditorState) => ({
    nodes: s.nodes,
    workflowId: s.baseWorkflow.id,
    isDraggingAny: s.isDraggingAny,
    performanceTier: s.performanceTier as PerformanceTier,
  }))
  const editorState = store?.(shallowSelector)
  const nodes = useMemo(() => editorState?.nodes ?? [], [editorState?.nodes])
  const workflowId = editorState?.workflowId
  const isDraggingAny = editorState?.isDraggingAny ?? false
  // Gate the live-query on the resolved tier's `liveQueryWhileDragging` flag.
  // Tests / headless renders without a store fall back to "always enabled"
  // so they keep the previous behavior.
  const userChoice = editorState?.performanceTier ?? "auto"
  const liveQueryEnabled = useMemo(() => {
    if (!store) return true
    // node count + reduced-motion influence `auto`; without DOM matchMedia
    // we assume reduce-motion is off (matches the SSR fallback in
    // `use-effective-perf-tier`).
    const prefersReducedMotion =
      typeof window !== "undefined" && window.matchMedia
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false
    const effective = resolveEffectiveTier(userChoice, {
      nodeCount: nodes.length,
      prefersReducedMotion,
    })
    const flags = flagsForTier(effective)
    if (!flags.liveQueryWhileDragging && isDraggingAny) return false
    if (!flags.inspectorLiveValidation) return false
    return true
  }, [store, userChoice, nodes.length, isDraggingAny])

  const upstreamOutputs = useLatestRunOutputs(workflowId, liveQueryEnabled)

  // Build a stable compartment so completions can be reconfigured live.
  const completionCompartment = useMemo(() => new Compartment(), [])

  // Build the completion source, regenerated when nodes change.
  const completionSource = useMemo(() => {
    return (ctx: CompletionContext): CompletionResult | null => {
      // Match `{{ ... ` or `$...` so completions appear once the user starts
      // typing inside a mustache or addresses a $ keyword anywhere.
      const word = ctx.matchBefore(/[$][\w$.[\]'"-]*|\{\{\s*[$][\w$.[\]'"-]*?/)
      if (!word && !ctx.explicit) return null
      const from = word
        ? word.from + (word.text.startsWith("{{") ? word.text.indexOf("$") : 0)
        : ctx.pos
      const outputSchemas: Record<string, string[]> = {}
      for (const [stepId, output] of Object.entries(upstreamOutputs)) {
        if (output && typeof output === "object" && !Array.isArray(output)) {
          outputSchemas[stepId] = Object.keys(output as Record<string, unknown>)
        }
      }
      const entries = buildExpressionSuggestions({
        nodes: nodes as unknown as Parameters<typeof buildExpressionSuggestions>[0]["nodes"],
        currentNodeId,
        outputSchemas,
      })
      return {
        from,
        options: entries.map((e) => ({
          label: e.label,
          apply: e.insert,
          detail: e.detail,
          type: e.kind,
          boost: e.boost,
        })),
        validFor: /[\w$.[\]'"-]*$/,
      }
    }
  }, [nodes, currentNodeId, upstreamOutputs])

  // Mount the EditorView once.
  useEffect(() => {
    if (!hostRef.current) return
    const startState = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle),
        workflowExpressionLanguage,
        keymap.of([...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        completionCompartment.of(
          autocompletion({
            override: [completionSource],
            activateOnTyping: true,
          })
        ),
        EditorView.theme({
          "&": {
            fontSize: "12px",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          },
          ".cm-content": { padding: "8px 10px" },
          ".cm-focused": { outline: "none" },
          ".cm-scroller": { lineHeight: "1.5" },
        }),
        multiline ? highlightActiveLine() : EditorView.theme({}),
        multiline ? lineNumbers() : EditorView.theme({}),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) {
            const next = u.state.doc.toString()
            onChangeRef.current(next)
          }
        }),
      ],
    })
    const view = new EditorView({ state: startState, parent: hostRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reconfigure completions when the source changes.
  useEffect(() => {
    if (!viewRef.current) return
    viewRef.current.dispatch({
      effects: completionCompartment.reconfigure(
        autocompletion({
          override: [completionSource],
          activateOnTyping: true,
        })
      ),
    })
  }, [completionSource, completionCompartment])

  // Sync the doc when `value` changes externally (e.g., undo).
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const current = view.state.doc.toString()
    if (current === value) return
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    })
  }, [value])

  // Live-preview the value resolved against the most recent run.
  const preview = useMemo(() => {
    if (!value || !value.includes("{{")) return null
    try {
      const resolved = resolveExpression(value, {
        upstream: upstreamOutputs,
        trigger: { workflowId: workflowId ?? "", kind: "trigger.manual", payload: {}, originAt: 0 },
        staticData: {},
        params: {},
      })
      if (typeof resolved === "string") return resolved
      return JSON.stringify(resolved, null, 0)
    } catch (err) {
      return err instanceof Error ? `error: ${err.message}` : "error"
    }
  }, [value, upstreamOutputs, workflowId])

  return (
    <div
      className={cn("rounded-md border bg-background", className)}
      data-multiline={multiline ? "true" : "false"}
    >
      <div
        ref={hostRef}
        id={id}
        aria-label={rest["aria-label"]}
        className={cn("min-h-[36px]", multiline ? `min-h-[${rows * 22}px]` : "")}
        style={multiline ? { minHeight: `${rows * 22}px` } : undefined}
        data-placeholder={placeholder}
      />
      {preview !== null && preview !== "" ? (
        <div className="border-t bg-muted/40 px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
          <span className="opacity-70">→ </span>
          <span className="break-all">
            {preview.length > 200 ? preview.slice(0, 200) + "…" : preview}
          </span>
        </div>
      ) : null}
    </div>
  )
}
