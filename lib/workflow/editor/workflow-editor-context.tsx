"use client"

/**
 * Workflow editor context — exposes the per-workflow editor store and a
 * quick-action dispatcher to anything mounted inside the editor's right
 * sidebar (today: the workflow-scoped chat composer toolbar).
 *
 * Why a context instead of prop drilling: the dedicated workflow toolbar
 * lives deep inside the generic `<ChatPane>` → `<Composer>` → `<BottomToolbar>`
 * tree, none of which know about workflow concerns. The Provider is mounted
 * once in `chat-tab.tsx` (which owns `useClaudeChat()`) and the toolbar
 * pulls what it needs via `useWorkflowEditor()`.
 *
 * Outside the workflow editor, `useWorkflowEditor()` returns `null` — the
 * generic chat callers never touch this context.
 */

import { createContext, useContext, type ReactNode } from "react"
import type { EditorStore } from "./store"

export type WorkflowQuickActionKind = "validate" | "explain" | "suggest"

export interface WorkflowEditorContextValue {
  /** Per-instance Zustand store hook for the currently-open workflow. */
  useEditorStore: EditorStore
  /**
   * Fire a workflow-specific quick action. The implementation lives in
   * `chat-tab.tsx` (which owns `useClaudeChat()`) and is responsible for
   * building the prompt and calling `claude.send(...)`.
   */
  onQuickAction: (kind: WorkflowQuickActionKind) => void | Promise<void>
}

const WorkflowEditorContext = createContext<WorkflowEditorContextValue | null>(null)

export function WorkflowEditorProvider({
  value,
  children,
}: {
  value: WorkflowEditorContextValue
  children: ReactNode
}) {
  return <WorkflowEditorContext.Provider value={value}>{children}</WorkflowEditorContext.Provider>
}

/**
 * Returns the workflow editor context value, or `null` when called outside
 * a `WorkflowEditorProvider`. The generic chat composer uses the `null`
 * return to decide whether to render the workflow toolbar variant.
 */
export function useWorkflowEditor(): WorkflowEditorContextValue | null {
  return useContext(WorkflowEditorContext)
}
