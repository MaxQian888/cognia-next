/**
 * Node-kind → risk surfaces for the Visual Workflow engine (ADR-0070 Phase 3).
 *
 * The workflow counterpart of the Team/goal risk adapters. Those two classify a
 * whole run from its roster or objective; a workflow is a DAG whose nodes each
 * do one concrete thing, so the node KIND *is* the evidence — far stronger than
 * either. `action.desktop.click` does not merely have access to the mouse, it
 * IS a mouse click.
 *
 * That strength is why this file does not go through `classifyRisk`'s text and
 * tool-id heuristics: it maps kinds to surfaces directly and reuses only the
 * severity table in `risk-surfaces.ts`, so a node's tier and a roster's tier
 * still mean the same thing.
 *
 * `RISKY_NODE_KINDS` is exhaustive over the kinds we consider risky and typed as
 * a `Record`, mirroring `permission-mode-meta.ts`: adding a risky kind without
 * describing it here is a compile error. Kinds absent from the map are low risk
 * by the layer's gate-on-positive-evidence rule (unknown ≠ risky).
 */

import { RISK_SURFACES, type RiskSurfaceId } from "@/lib/policy/risk/risk-surfaces"
import type { RiskAssessment, RiskTier } from "@/lib/policy/risk/classify-risk"

/**
 * Every node kind that carries risk, and the surface it carries.
 *
 * Judgment calls worth stating, because the absences are deliberate:
 *
 *  - `action.connector.send` / `.forward` reach a real recipient and cannot be
 *    unsent → `external-send`. `.draft` writes a draft nobody has read and
 *    `.reaction` toggles an emoji — both trivially reversible, both absent.
 *  - `action.connector.delete` destroys a message someone may rely on →
 *    `data-destructive`.
 *  - `action.desktop.*` drive the operator's machine → `computer-use`.
 *    `.screenshot` is included: it exfiltrates whatever is on screen, which is
 *    the same surface even though it moves nothing. `.wait` is not.
 *  - `action.system.terminal` / `action.terminal.script` / `.session.run`
 *    execute real shell → `native-command`.
 *  - `action.git.push` publishes commits to a remote others pull → it leaves the
 *    machine and cannot be cleanly unsent → `external-send`. `.commit` /
 *    `.stage` / `.branch` are local and reversible → absent.
 *  - `action.mobile.share` hands content to another app / person →
 *    `external-send`. `.notify` is a local notification → absent.
 *  - Deletes of app-local records (`action.goal.delete`, `action.plan.delete`,
 *    `action.scheduler.task.delete`) are deliberately ABSENT. They destroy
 *    something, but gating a workflow that tidies up its own goals would fire on
 *    routine automation and train operators to switch `riskGating` off — losing
 *    the shell/mouse/send gating that is the point. The layer gates what escapes
 *    the app or cannot be undone, not every mutation.
 *  - `action.plugin.invoke` / `action.skill.invoke` are wildcards: a plugin can
 *    do anything. They are ABSENT because a rule that gates every plugin call
 *    gates most real workflows. Plugin calls stay covered by the plugin
 *    permission guard, which is a per-capability gate and a better fit.
 */
export const RISKY_NODE_KINDS: Record<string, RiskSurfaceId> = {
  // ── Reaches a real recipient, irreversibly ──
  "action.connector.send": "external-send",
  "action.connector.forward": "external-send",
  "action.mobile.share": "external-send",
  "action.git.push": "external-send",
  // ── Drives the operator's machine ──
  "action.desktop.click": "computer-use",
  "action.desktop.keys": "computer-use",
  "action.desktop.type": "computer-use",
  "action.desktop.paste": "computer-use",
  "action.desktop.screenshot": "computer-use",
  // ── Executes real shell ──
  "action.system.terminal": "native-command",
  "action.terminal.script": "native-command",
  "action.terminal.session.run": "native-command",
  // ── Destroys something a human may rely on ──
  "action.connector.delete": "data-destructive",
}

/** The risky node kinds, derived from the map. */
export const RISKY_NODE_KIND_IDS = Object.keys(RISKY_NODE_KINDS)

/**
 * Map a surface's severity onto a tier, the same way `classify-risk.ts` does, so
 * a node's tier and a roster's tier mean the same thing.
 *
 * Every kind in {@link RISKY_NODE_KINDS} currently maps to a `high` surface —
 * the two `elevated` surfaces (`credential-auth`, `file-write-broad`) have no
 * node kind that expresses them. The `elevated` branch is kept (rather than
 * hard-coding `"high"`) because it is the taxonomy, not this map, that decides
 * severity: the day an elevated-surface kind is added, this stays correct.
 */
export function tierForSurface(surface: RiskSurfaceId): RiskTier {
  return RISK_SURFACES[surface].severity === "high" ? "high" : "medium"
}

/**
 * Classify a single workflow node. Returns a `low` assessment for any kind not
 * in {@link RISKY_NODE_KINDS} — the same positive-evidence default the rest of
 * the layer uses.
 */
export function classifyNodeRisk(node: { type: string }): RiskAssessment {
  const surface = RISKY_NODE_KINDS[node.type]
  if (!surface) {
    return { tier: "low", surfaces: [], reason: "low — no risk surfaces detected" }
  }
  const tier = tierForSurface(surface)
  return {
    tier,
    surfaces: [{ id: surface, evidence: node.type }],
    reason: `${tier} — ${surface}`,
  }
}
