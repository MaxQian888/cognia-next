/**
 * Which React Flow changes are edits to the workflow.
 *
 * `onNodesChange` / `onEdgesChange` carry the user's edits and React Flow's
 * own bookkeeping through one channel. Treating every change as an edit made
 * a workflow read "Unsaved changes" the moment it opened (each node reports a
 * `dimensions` change once it is measured) and again on every click (a
 * `select` change) — so the indicator stopped meaning anything, and leaving
 * the editor warned about edits nobody made.
 */

import type { EdgeChange, NodeChange } from "@xyflow/react"

/**
 * Adds, removals, replacements and moves are edits. A `dimensions` change is
 * one only when a person resized the node (`NodeResizer` reports `resizing`
 * and writes the size back as attributes); the measurement React Flow makes
 * after mount is not. Selection never is.
 */
export function isNodeEdit(change: NodeChange): boolean {
  switch (change.type) {
    case "add":
    case "remove":
    case "replace":
    case "position":
      return true
    case "dimensions":
      return change.resizing === true || Boolean(change.setAttributes)
    default:
      return false
  }
}

/** Adds, removals and replacements are edits; selection is not. */
export function isEdgeEdit(change: EdgeChange): boolean {
  return change.type === "add" || change.type === "remove" || change.type === "replace"
}
