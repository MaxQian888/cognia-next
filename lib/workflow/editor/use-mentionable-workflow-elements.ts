"use client"

/**
 * Reactive source of `@`-mentionable workflow elements for the copilot
 * composer. Projects the editor store's live nodes + edges into the flat
 * {@link MentionableWorkflowElement} shape the chat popover renders and fuzzy-
 * matches over. Picking a row stages a reference chip (see `composer.tsx`'s
 * `onPickPopoverItem`), which is expanded to `@node:<id>` / `@edge:<id>` and
 * cited to the agent at send time (`mention-expand.ts`).
 *
 * The list is capped so a huge graph can't build an unbounded popover; the
 * fuzzy filter still runs over the whole cap.
 */

import { useMemo } from "react"
import type { MentionableWorkflowElement } from "@/components/chat/composer-trigger"
import type { EditorState, EditorStore } from "./store"

/** Upper bound on rows fed to the picker (mirrors Spotlight's 200-node cap). */
const MAX_ELEMENTS = 300

/**
 * Pure projection of the editor store's nodes + edges into mentionable
 * elements. Exported so non-reactive callers (the "reference selection"
 * toolbar action) can resolve refs on click via `getState()` without adding a
 * graph subscription to the toolbar.
 */
export function buildMentionableWorkflowElements(
  nodes: EditorState["nodes"],
  edges: EditorState["edges"]
): MentionableWorkflowElement[] {
  // Resolve node labels once so edge endpoints read as names, not raw ids.
  const labelById = new Map<string, string>()
  for (const n of nodes) {
    const raw = typeof n.data.label === "string" ? n.data.label.trim() : ""
    labelById.set(n.id, raw || n.id)
  }

  const els: MentionableWorkflowElement[] = []
  for (const n of nodes.slice(0, MAX_ELEMENTS)) {
    const kind = typeof n.data.kind === "string" ? n.data.kind : "unknown"
    const label = labelById.get(n.id) ?? n.id
    els.push({
      type: "node",
      id: n.id,
      label,
      kind,
      sublabel: kind,
      searchText: `${n.id} ${label} ${kind}`.toLowerCase(),
    })
  }
  for (const e of edges.slice(0, MAX_ELEMENTS)) {
    const kind = typeof e.data?.kind === "string" ? e.data.kind : "default"
    const src = labelById.get(e.source) ?? e.source
    const tgt = labelById.get(e.target) ?? e.target
    const endpoints = `${src} → ${tgt}`
    const explicit =
      typeof e.data?.label === "string" && e.data.label.trim()
        ? e.data.label.trim()
        : typeof e.label === "string" && e.label
          ? e.label
          : ""
    const label = explicit || endpoints
    els.push({
      type: "edge",
      id: e.id,
      label,
      kind,
      sublabel: endpoints,
      searchText: `${e.id} ${label} ${src} ${tgt} ${kind}`.toLowerCase(),
    })
  }
  return els
}

/**
 * Cheap change signature over exactly the fields the projection reads. Node
 * drags replace the `nodes` array ~60×/s with only positions changed; keying
 * the subscription on this string (a primitive, so an identical value never
 * re-renders) keeps the ChatTab from rebuilding the list every drag frame.
 */
function mentionFingerprint(nodes: EditorState["nodes"], edges: EditorState["edges"]): string {
  let fp = ""
  for (const n of nodes) {
    const label = typeof n.data.label === "string" ? n.data.label : ""
    const kind = typeof n.data.kind === "string" ? n.data.kind : ""
    fp += `${n.id}${label}${kind}`
  }
  fp += ""
  for (const e of edges) {
    const label =
      typeof e.data?.label === "string" ? e.data.label : typeof e.label === "string" ? e.label : ""
    const kind = typeof e.data?.kind === "string" ? e.data.kind : ""
    fp += `${e.id}${e.source}${e.target}${label}${kind}`
  }
  return fp
}

export function useMentionableWorkflowElements(
  useStore: EditorStore
): MentionableWorkflowElement[] {
  const fingerprint = useStore((s: EditorState) => mentionFingerprint(s.nodes, s.edges))
  return useMemo(() => {
    const { nodes, edges } = useStore.getState()
    return buildMentionableWorkflowElements(nodes, edges)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint covers every field the projection reads
  }, [useStore, fingerprint])
}
