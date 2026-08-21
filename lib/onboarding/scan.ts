import type { MigrationVendor, MigrationVendorProbe } from "@/lib/agent-migration/types"
import type { OnboardingShell } from "@cognia/agent-config-types"

/**
 * Local capabilities the starter cards gate on (ADR-0122, decision 6).
 *
 * Kept to what a card actually needs to run, not to what a subsystem exists
 * for. The old 6-slide tour pitched OCR, automation, connectors and the twin
 * regardless of whether any of them were usable on the machine in front of the
 * user; gating on a probed capability is the fix, and a capability nobody
 * gates on has no reason to be in this list.
 */
export type OnboardingCapability = "fs" | "ocr" | "web"

export const ONBOARDING_CAPABILITIES = [
  "fs",
  "ocr",
  "web",
] as const satisfies readonly OnboardingCapability[]

/** One agent runtime found on this machine. */
export interface ScannedRuntime {
  /** External-agent preset id, e.g. `claude-code`. */
  id: string
  /** Display label, resolved by the caller from the preset catalog. */
  label: string
  /**
   * Whether the runtime can reach a model without Cognia supplying
   * credentials — an already-authenticated CLI. This is what lets the flow
   * skip the provider step.
   */
  authenticated: boolean
}

export interface ScanResult {
  runtimes: ScannedRuntime[]
  /** Vendors whose configuration could be imported (ADR-0107). */
  migratable: MigrationVendorProbe[]
  capabilities: OnboardingCapability[]
}

export const EMPTY_SCAN: ScanResult = { runtimes: [], migratable: [], capabilities: [] }

/**
 * Whether the user can reach a model at all, from any source.
 *
 * Three sources count, and no two of them live in the same place — which is
 * why this takes three inputs rather than reading settings itself:
 *
 *  - `credentialsOk` is the chat path's own verdict (`useCredentialStatus`):
 *    a keyring API key or an OAuth bearer under Tauri, or a resolved BYOK
 *    provider in standalone mode. `null` while the probe is in flight, and on
 *    a paired phone, which borrows the desktop's credentials and has nothing
 *    local to answer with.
 *  - `providerConfigured` is a settings-resolved AI-SDK provider (OpenAI,
 *    Google, a local Ollama, a custom base URL…). The Tauri probe cannot see
 *    these: `hasApiKey()` reads an Anthropic-only env slot, so a desktop user
 *    running entirely on OpenAI reads as `keyOk: false`.
 *  - an already-authenticated `claude-code` the scan found, which reaches a
 *    model *without* any Cognia-side credentials at all.
 *  - `legacyApiKey` (`settings.apiKey`), the pre-`providerSettings` Anthropic
 *    slot. Still real — it is pushed into the Rust `ApiKeyState` at boot — and
 *    read directly rather than waited for, because the probe that would
 *    otherwise report it (`hasApiKey()`) only answers *after* that boot-time
 *    sync lands, and the latch takes the first settled verdict.
 *
 * This used to read `settings.defaultProvider` as "has a subscription". That
 * field is the active default AI provider id (`"openai"`, `"anthropic"`, …),
 * not evidence of a credential, and nothing in the sign-in path writes it — so
 * the flow believed a user who had just connected Claude Pro had no model, and
 * believed a user who had merely *picked* a provider did.
 */
export function hasModelAccess(input: {
  scan: ScanResult
  /** `useCredentialStatus().keyOk` — `null` until the probe settles. */
  credentialsOk: boolean | null
  /** A settings-resolved provider+credential (`resolveStandaloneProvider`). */
  providerConfigured: boolean
  /** `settings.apiKey`, the legacy Anthropic-only slot. */
  legacyApiKey?: string
}): boolean {
  if (input.credentialsOk === true) return true
  if (input.providerConfigured) return true
  if (input.legacyApiKey?.trim()) return true
  return input.scan.runtimes.some((r) => r.authenticated)
}

/** Vendors worth offering to import — installed, and not already imported. */
export function migratableVendors(probes: readonly MigrationVendorProbe[]): MigrationVendor[] {
  return probes.filter((p) => p.installed).map((p) => p.vendor)
}

// ---------------------------------------------------------------------------
// Scan phase / timeout policy
// ---------------------------------------------------------------------------

/**
 * How long an empty result stays "still scanning" before it becomes the
 * genuine "nothing here" state — *unless* the probe reports it is still
 * working, in which case the hard ceiling applies instead.
 */
export const SCAN_SOFT_TIMEOUT_MS = 5_000

/**
 * Absolute ceiling. Even while a probe still claims to be running, fall
 * through to the empty state after this, so a wedged executable-version query
 * can never pin the user on a spinner forever.
 */
export const SCAN_HARD_TIMEOUT_MS = 20_000

export type ScanPhase = "scanning" | "found" | "empty"

/**
 * Decide what the scan step should render.
 *
 * **Why two timers.** Multica shipped a single timeout here and had to fix it
 * (their code cites MUL-5119): the daemon was still probing when the screen
 * flipped to "no runtime found", so users skipped a step that would have
 * succeeded a second later. A false negative on this step is expensive —
 * it costs the user the runtime they already had installed.
 *
 * Cognia's probe chain is *longer* than the one that produced that bug —
 * filesystem probe, then executable resolution, then version queries — so the
 * same failure is more likely here, not less. The soft timer gives the normal
 * budget; `pending` suppresses it while work is genuinely in flight; the hard
 * timer bounds the suppression so a hung probe still resolves.
 *
 * @param found   Anything discovered so far (runtimes or migratable vendors).
 * @param pending Whether the probe reports work still in flight.
 * @param elapsedMs Milliseconds since the scan started.
 */
export function resolveScanPhase(input: {
  found: boolean
  pending: boolean
  elapsedMs: number
}): ScanPhase {
  if (input.found) return "found"
  if (input.elapsedMs >= SCAN_HARD_TIMEOUT_MS) return "empty"
  if (input.pending) return "scanning"
  if (input.elapsedMs >= SCAN_SOFT_TIMEOUT_MS) return "empty"
  return "scanning"
}

/**
 * Whether this shell runs the machine scan at all.
 *
 * A paired phone reaches the scan *step*, but its body is the pairing flow —
 * there is no local runtime to find, because the compute lives on the desktop
 * it is pairing with. Only the desktop actually probes.
 */
export function shellRunsMachineScan(shell: OnboardingShell): boolean {
  return shell === "tauri"
}
