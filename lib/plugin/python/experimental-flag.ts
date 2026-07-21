/**
 * Gate for python-backed contributions whose capability contract marks
 * `pythonExecution: "experimental"`.
 *
 * Three capabilities can be *declared* python-backed but are not yet proven on
 * the subprocess seam, each for a concrete reason recorded in
 * `packages/plugin-sdk/contract/catalog.json`:
 *
 * - `connectors` — bidirectional: inbound arrives over the `plugin:python`
 *   push channel and `health()` is answered from wrapper-tracked state.
 * - `chat-middleware` — the Koa-style `next` continuation cannot cross the
 *   process boundary, so the wrapper synthesizes around-semantics from a
 *   `before`/`after` pair (no multi-call / retry control flow).
 * - `terminal-completion` — inline completion is latency-budgeted and pays an
 *   extra IPC round-trip.
 *
 * DEFAULT OFF. Registration always happens (so the manifest, lint and the
 * plugin detail UI tell the truth); only the *executing* bridges consult this
 * flag, exactly like `isChatMiddlewareExecutionEnabled`.
 */

import { PLUGIN_MANIFEST_CONTRIBUTIONS } from "@/packages/plugin-sdk/src/contracts/catalog"

let experimentalPythonBackedEnabled = false

/** Whether experimental python-backed contributions may execute. */
export function isExperimentalPythonBackedEnabled(): boolean {
  return experimentalPythonBackedEnabled
}

/** Toggle experimental python-backed execution (settings UI / tests). */
export function setExperimentalPythonBackedEnabled(enabled: boolean): void {
  experimentalPythonBackedEnabled = enabled
}

/**
 * Is this manifest field's python backing still experimental? Derived from the
 * contract rather than a hand-kept list, so flipping a capability to
 * `"supported"` in the catalog retires the gate automatically.
 */
export function isExperimentalPythonContribution(manifestField: string): boolean {
  const contract = PLUGIN_MANIFEST_CONTRIBUTIONS.find((entry) => entry.field === manifestField)
  return contract?.pythonExecution === "experimental"
}

/**
 * May a python-backed contribution for `manifestField` execute right now?
 * `supported` capabilities always may; `experimental` ones need the flag.
 */
export function canRunPythonBackedContribution(manifestField: string): boolean {
  return !isExperimentalPythonContribution(manifestField) || experimentalPythonBackedEnabled
}

/** Test-only reset to the shipped default (off). */
export function __resetExperimentalPythonFlagForTesting(): void {
  experimentalPythonBackedEnabled = false
}
