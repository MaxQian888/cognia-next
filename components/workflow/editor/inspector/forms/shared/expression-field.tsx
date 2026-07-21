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

import { useCallback, useEffect, useMemo, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
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
import { linter, type Diagnostic as CmLintDiagnostic } from "@codemirror/lint"
import { useTranslations } from "next-intl"
import { workflowExpressionLanguage } from "@/lib/workflow/editor/expression-language"
import {
  buildExpressionSuggestions,
  deriveExpressionScopeHints,
} from "@/lib/workflow/editor/expression-suggestions"
import { computeExpressionDiagnostics } from "@/lib/workflow/editor/expression-diagnostics"
import { computeUpstreamNodeIds } from "@/lib/workflow/editor/upstream-graph"
import { flattenSchema } from "@/lib/workflow/editor/node-io-data"
import { buildNodeRef, EXPR_DRAG_MIME, parseExprDrag } from "@/lib/workflow/editor/expr-ref"
import { resolveExpression } from "@/lib/workflow/runtime/expression"
import { useLatestRunOutputs } from "@/hooks/workflow/use-latest-run-outputs"
import type { EditorStore, EditorState as WfEditorState } from "@/lib/workflow/editor/store"
import type { WorkflowNode } from "@/types/workflow/visual"
import { cn } from "@/lib/utils"
import { useInspectorExpressionCtx } from "./inspector-context"
import { VariablePicker } from "./variable-picker"

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
  const tDiag = useTranslations("workflows.diagnostics")

  // Pull latest workflow nodes from the store if available — this drives
  // node-aware completions. `useShallow` must be called unconditionally to
  // satisfy rules-of-hooks; the resulting selector is then optionally invoked.
  const shallowSelector = useShallow((s: WfEditorState) => ({
    nodes: s.nodes,
    edges: s.edges,
    workflowId: s.baseWorkflow.id,
    variables: s.baseWorkflow.variables,
    pinData: s.baseWorkflow.pinData,
    staticData: s.baseWorkflow.staticData,
    workflowInputSchema: s.baseWorkflow.interface?.inputSchema,
    isDraggingAny: s.isDraggingAny,
    performanceTier: s.performanceTier as PerformanceTier,
  }))
  const editorState = store?.(shallowSelector)
  const nodes = useMemo(() => editorState?.nodes ?? [], [editorState?.nodes])
  const edges = useMemo(() => editorState?.edges ?? [], [editorState?.edges])
  const expressionNodes = useMemo<WorkflowNode[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: node.data.kind,
        typeVersion: node.data.typeVersion,
        position: node.position,
        data: node.data,
        width: node.width,
        height: node.height,
        parentId: node.parentId,
      })),
    [nodes]
  )
  // Projections for the variable picker (B3) — minimal {id,kind,label} / edges.
  const pickerNodes = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        kind: n.data.kind as string,
        label: (n.data.label as string) ?? n.id,
      })),
    [nodes]
  )
  const pickerEdges = useMemo(
    () => edges.map((e) => ({ source: e.source, target: e.target })),
    [edges]
  )
  const workflowId = editorState?.workflowId
  const varKeys = useMemo(() => Object.keys(editorState?.variables ?? {}), [editorState?.variables])
  const pinData = editorState?.pinData
  const staticData = editorState?.staticData
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

  // Pin data overlays the latest run's outputs (pin wins) so the preview +
  // autocomplete reflect frozen test fixtures while they're set.
  const runOutputs = useLatestRunOutputs(workflowId, liveQueryEnabled)
  const upstreamOutputs = useMemo(
    () => (pinData ? { ...runOutputs, ...pinData } : runOutputs),
    [runOutputs, pinData]
  )

  const upstreamNodeIds = useMemo(
    () =>
      currentNodeId
        ? computeUpstreamNodeIds(
            currentNodeId,
            nodes.map((node) => ({ id: node.id, kind: node.data.kind as string })),
            edges.map((edge) => ({ source: edge.source, target: edge.target }))
          )
        : undefined,
    [currentNodeId, nodes, edges]
  )
  const outputSchemas = useMemo(() => {
    const schemas: Record<string, string[]> = {}
    for (const [stepId, output] of Object.entries(upstreamOutputs)) {
      if (output && typeof output === "object") {
        schemas[stepId] = flattenSchema(output, { maxDepth: 3, maxRows: 60 }).map((row) => row.path)
      }
    }
    return schemas
  }, [upstreamOutputs])
  const scopeHints = useMemo(
    () =>
      deriveExpressionScopeHints({
        nodes: expressionNodes,
        upstreamNodeIds,
        staticData,
        outputs: upstreamOutputs,
        workflowInputSchema: editorState?.workflowInputSchema,
      }),
    [
      expressionNodes,
      upstreamNodeIds,
      staticData,
      upstreamOutputs,
      editorState?.workflowInputSchema,
    ]
  )

  // Insert a reference at the current cursor — shared by the variable picker
  // (B3) and reusing the exact dispatch the drag-drop handler uses.
  const insertAtCursor = useCallback((ref: string) => {
    const view = viewRef.current
    if (!view) return
    const pos = view.state.selection.main.head
    view.dispatch({
      changes: { from: pos, to: pos, insert: ref },
      selection: { anchor: pos + ref.length },
    })
    view.focus()
  }, [])

  // Build a stable compartment so completions can be reconfigured live.
  const completionCompartment = useMemo(() => new Compartment(), [])
  // Separate compartment for the invalid-reference linter (B2).
  const lintCompartment = useMemo(() => new Compartment(), [])

  // Linter: underline `$node['id']` references that point at an unknown node
  // (error) or a node that isn't upstream of this one (warning). Rebuilt when
  // the graph or current node changes; debounced so typing isn't re-linted
  // every keystroke.
  const lintExtension = useMemo(() => {
    return linter(
      (view): CmLintDiagnostic[] => {
        if (!currentNodeId) return []
        const graphNodes = nodes.map((n) => ({ id: n.id, kind: n.data.kind as string }))
        const graphEdges = edges.map((e) => ({ source: e.source, target: e.target }))
        return computeExpressionDiagnostics(
          view.state.doc.toString(),
          currentNodeId,
          graphNodes,
          graphEdges
        ).map((d) => ({
          from: d.from,
          to: d.to,
          severity: d.severity,
          message: tDiag(d.code === "unknownNode" ? "exprUnknownNode" : "exprNotUpstream", {
            ref: d.ref,
          }),
        }))
      },
      { delay: 300 }
    )
  }, [nodes, edges, currentNodeId, tDiag])

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
      const entries = buildExpressionSuggestions({
        nodes: expressionNodes,
        currentNodeId,
        outputSchemas,
        varKeys,
        upstreamNodeIds,
        staticKeys: scopeHints.staticKeys,
        triggerHints: scopeHints.triggerHints,
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
  }, [expressionNodes, currentNodeId, outputSchemas, varKeys, upstreamNodeIds, scopeHints])

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
        lintCompartment.of(lintExtension),
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
        // Drag-to-map: dropping a field chip from the NDV data view inserts its
        // `{{ $node['id'].path }}` reference at the drop position.
        EditorView.domEventHandlers({
          dragover(event) {
            if (event.dataTransfer?.types.includes(EXPR_DRAG_MIME)) {
              event.preventDefault()
              return true
            }
            return false
          },
          drop(event, view) {
            const payload = parseExprDrag(event.dataTransfer?.getData(EXPR_DRAG_MIME))
            if (!payload) return false
            event.preventDefault()
            const ref = buildNodeRef(payload.nodeId, payload.segments)
            const pos =
              view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
              view.state.selection.main.head
            view.dispatch({
              changes: { from: pos, to: pos, insert: ref },
              selection: { anchor: pos + ref.length },
            })
            view.focus()
            return true
          },
        }),
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

  // Reconfigure the linter when the graph / current node changes.
  useEffect(() => {
    if (!viewRef.current) return
    viewRef.current.dispatch({
      effects: lintCompartment.reconfigure(lintExtension),
    })
  }, [lintExtension, lintCompartment])

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
        staticData: staticData ?? {},
        params: {},
      })
      if (typeof resolved === "string") return resolved
      // JSON.stringify(undefined) yields `undefined` (not a string) — an
      // unresolvable expression must not crash the preview row.
      return JSON.stringify(resolved, null, 0) ?? null
    } catch (err) {
      return err instanceof Error ? `error: ${err.message}` : "error"
    }
  }, [value, upstreamOutputs, workflowId, staticData])

  return (
    <div
      className={cn("rounded-md border bg-background", className)}
      data-multiline={multiline ? "true" : "false"}
    >
      {store && currentNodeId ? (
        <div className="flex justify-end border-b px-1 py-0.5">
          <VariablePicker
            currentNodeId={currentNodeId}
            nodes={pickerNodes}
            edges={pickerEdges}
            outputs={upstreamOutputs}
            onInsert={insertAtCursor}
          />
        </div>
      ) : null}
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
