/**
 * Desktop-only node check. Many node kinds (terminal, desktop UI automation,
 * webhook triggers, git, …) only function inside the Tauri shell. In browser
 * mode they can't run, so warn the author at edit time rather than failing the
 * run. Reuses the catalog's `desktopOnly` flag — the single source of truth
 * the palette already keys on.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import { nodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import { makeDiagnostic } from "../diagnostic-id"
import type { Diagnostic } from "../types"

export function checkDesktopOnly(wf: VisualWorkflow, isWeb: boolean): Diagnostic[] {
  if (!isWeb) return []
  const out: Diagnostic[] = []
  for (const node of wf.nodes) {
    if (nodeCatalogEntry(node.type).desktopOnly) {
      out.push(makeDiagnostic({ severity: "warning", code: "desktopOnlyInWeb", nodeId: node.id }))
    }
  }
  return out
}
