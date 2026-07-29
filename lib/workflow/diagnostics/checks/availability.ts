/**
 * Static availability preflight — surfaces problems the runtime would
 * otherwise only hit mid-run:
 *   • `credentialMissing` (error) — a node references a credential id that
 *     isn't declared in the workflow's `credentials` map. This is a static
 *     check (declaration present?), NOT a keychain probe — the actual secret
 *     is resolved asynchronously at run time on desktop only.
 *   • `pluginUnavailable` (warning) — a plugin-contributed node kind whose
 *     provider isn't currently installed/registered. Gated behind an injected
 *     predicate so this module stays pure.
 *   • `kindRetired` (error) — an unavailable kind that this app used to
 *     provide and no longer does. Split out from `pluginUnavailable` because
 *     that message tells the user to install a plugin, which for a retired
 *     kind is advice they cannot act on.
 */

import type { VisualWorkflow } from "@/types/workflow/visual"
import { retiredNodeKind } from "@/lib/workflow/nodes/retired-kinds"
import { makeDiagnostic } from "../diagnostic-id"
import type { Diagnostic } from "../types"

export function checkCredentials(wf: VisualWorkflow): Diagnostic[] {
  const creds = wf.credentials ?? {}
  const credExists = (id: string): boolean =>
    id in creds || Object.values(creds).some((c) => c.id === id)

  const out: Diagnostic[] = []
  for (const node of wf.nodes) {
    const refs = node.data?.credentialRefs
    if (!refs) continue
    const missing = new Set<string>()
    for (const credId of Object.values(refs)) {
      if (!credId || missing.has(credId) || credExists(credId)) continue
      missing.add(credId)
      out.push(
        makeDiagnostic({
          severity: "error",
          code: "credentialMissing",
          nodeId: node.id,
          messageParams: { ref: credId },
        })
      )
    }
  }
  return out
}

export function checkKindAvailability(
  wf: VisualWorkflow,
  isKindAvailable: (kind: string) => boolean
): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const node of wf.nodes) {
    // Availability wins over retirement: the compatibility plugin re-registers
    // the retired kind strings, so a workflow whose provider is installed is
    // not broken and must not be reported as such.
    if (isKindAvailable(node.type)) continue
    const retired = retiredNodeKind(node.type)
    out.push(
      retired
        ? makeDiagnostic({
            // An uninstalled plugin is a warning because installing it fixes
            // the workflow. A retired kind has no such remedy in the product,
            // so the run would fail at this step — report it before it starts.
            severity: "error",
            code: "kindRetired",
            nodeId: node.id,
            messageParams: { kind: node.type, removedIn: retired.removedIn },
          })
        : makeDiagnostic({
            severity: "warning",
            code: "pluginUnavailable",
            nodeId: node.id,
            messageParams: { kind: node.type },
          })
    )
  }
  return out
}
