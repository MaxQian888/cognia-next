/**
 * Canonical data model for recorded browser flows. See ADR-0072.
 *
 * A `RecordedFlow` is the single source of truth: the capture path (the injected
 * overlay) produces it, the replay path consumes it, and every export format
 * (JSON / Playwright spec / agent context) is a pure serializer over it. Keep
 * this module free of Tauri and DOM imports so it stays testable in the `node`
 * jest project.
 *
 * Why steps carry a `selector` and not a snapshot `ref`: refs are minted per
 * snapshot `generation` and are meaningless once the document reloads, which is
 * exactly what happens in the middle of any realistic flow (a login submit).
 * Replay re-resolves `selector` → `ref` against a fresh snapshot at each step.
 */

/** Discriminator for {@link RecordedStep}. */
export type RecordedStepAct = "navigate" | "click" | "fill" | "select" | "press_key" | "wait_for"

/**
 * How to find an element again at replay time. Captured at record time from the
 * live DOM; `role`/`name` are recorded opportunistically because they are what
 * makes the Playwright export emit a readable `getByRole` locator instead of a
 * brittle CSS path.
 */
export interface RecordedTarget {
  /** Durable CSS selector — the replay anchor (see module docblock). */
  selector: string
  /** ARIA role at record time, or null when the element had no mapped role. */
  role: string | null
  /** Accessible name at record time, or null. */
  name: string | null
  /** Short human-readable path (`div.card > button#submit`) for the step list UI. */
  domPath: string | null
}

interface StepBase {
  /**
   * Monotonic counter from the page's `tick`, not a wall clock: it only orders
   * steps within one document. It resets across navigations, so never use it to
   * compute durations.
   */
  at: number
}

/** A top-level navigation — either user-typed or the result of a click. */
export interface NavigateStep extends StepBase {
  act: "navigate"
  url: string
}

export interface ClickStep extends StepBase {
  act: "click"
  target: RecordedTarget
  /** Modifier keys held during the click, e.g. `["ctrl"]`. Omitted when none. */
  modifiers?: string[]
}

/** A settled value for a text input / textarea (recorded on `change`, not per keystroke). */
export interface FillStep extends StepBase {
  act: "fill"
  target: RecordedTarget
  /** Always `""` when {@link FillStep.secret} — a credential is never captured. */
  value: string
  /**
   * The field was a password input, so its value was deliberately NOT recorded.
   * Flows persist to Dexie and the agent export is written to a model prompt, so
   * capturing it would put a credential at rest and on the wire. Replay resolves
   * the value from a caller-supplied secrets map; exports emit an env var.
   */
  secret?: boolean
}

export interface SelectStep extends StepBase {
  act: "select"
  target: RecordedTarget
  value: string
}

export interface PressKeyStep extends StepBase {
  act: "press_key"
  /** Chord in the existing `parseKeyChord` vocabulary (`Enter`, `ctrl+a`, …). */
  key: string
  /** The focused element when the key was pressed, when identifiable. */
  target?: RecordedTarget
}

/**
 * An assertion. Never auto-captured — a person adds it from the step list to
 * pin down what the flow is supposed to prove. Without these a recording is a
 * script; with them it is a test.
 */
export interface WaitForStep extends StepBase {
  act: "wait_for"
  text: string
}

export type RecordedStep =
  NavigateStep | ClickStep | FillStep | SelectStep | PressKeyStep | WaitForStep

export interface RecordedFlow {
  id: string
  /** User-facing name; defaults to the base URL until renamed. */
  name: string
  /** Origin the recording started on — replay navigates here first. */
  baseUrl: string
  createdAt: number
  updatedAt: number
  steps: RecordedStep[]
}

/** Steps that address an element. Narrowing helper for exporters and the UI. */
export function hasTarget(
  step: RecordedStep
): step is ClickStep | FillStep | SelectStep | (PressKeyStep & { target: RecordedTarget }) {
  return "target" in step && step.target != null
}

/**
 * The step that survives when `next` collapses into `prev`, or null when the two
 * are distinct interactions that must both replay. Successive `fill`/`select` on
 * the same element are edits of one value, and replaying the intermediate ones
 * is both slower and less faithful (the page only ever saw the settled value on
 * `change`).
 *
 * Why this returns the survivor instead of a boolean: for a `fill`, deciding
 * "these collapse" and deciding "what survives" cannot be separated without
 * letting the `secret` flag be dropped on the floor. Secrecy is a property of
 * the FIELD, not of one `change` event — a user can hit the reveal toggle on a
 * password input (it becomes `type="text"`), fix a typo, and the overlay then
 * reports a plaintext `change` on the same selector. If the caller derived the
 * survivor itself it would naturally pick `next` and silently downgrade a
 * credential to plaintext. Funnelling both decisions through here makes that
 * state unrepresentable: you cannot learn that a collapse applies without also
 * being handed the correctly-merged step.
 */
function collapsed(prev: RecordedStep, next: RecordedStep): RecordedStep | null {
  if (prev.act !== next.act) return null
  if (next.act !== "fill" && next.act !== "select") return null
  const a = prev as FillStep | SelectStep
  const b = next as FillStep | SelectStep
  if (a.target.selector !== b.target.selector) return null
  if (next.act === "select") return b
  // Secrecy is a one-way latch: if either side of the collapse is secret, the
  // survivor is. `value: ""` is re-asserted rather than taken from `b`, because
  // a plaintext step carries the credential in `value` — keeping it would put it
  // at rest in Dexie and into the exports (a literal in the Playwright spec, a
  // model prompt in the agent export). Never downgrade; only ever latch on.
  const secret = (prev as FillStep).secret === true || (next as FillStep).secret === true
  return secret ? { ...(b as FillStep), secret: true, value: "" } : b
}

/**
 * True when `next` collapses into `prev` rather than following it.
 *
 * This is a predicate for callers that only need the yes/no (step-list UI,
 * tests). Never use it to build the survivor yourself — `supersedes(secret,
 * plain)` is true, and replacing the secret step with the plain one is exactly
 * the credential leak {@link collapsed} exists to prevent. {@link appendStep}
 * owns the merge.
 */
export function supersedes(prev: RecordedStep, next: RecordedStep): boolean {
  return collapsed(prev, next) !== null
}

/**
 * Append a step, collapsing supersede-able edits and consecutive duplicate
 * navigations (a click that navigates reports through both the click handler
 * and the history hook, and a redirect chain reports every hop).
 */
export function appendStep(steps: RecordedStep[], next: RecordedStep): RecordedStep[] {
  const prev = steps[steps.length - 1]
  if (!prev) return [next]
  const merged = collapsed(prev, next)
  if (merged) return [...steps.slice(0, -1), merged]
  if (prev.act === "navigate" && next.act === "navigate" && prev.url === next.url) {
    return steps
  }
  return [...steps, next]
}

/** A flow is replayable only if it actually does something. */
export function isReplayable(flow: RecordedFlow): boolean {
  return flow.steps.some((s) => s.act !== "wait_for")
}

/**
 * Stable key for a secret field, used both as the env-var name in exports and
 * as the lookup key in the replayer's secrets map — they must agree, or an
 * exported spec would read a variable the UI never told the user to set.
 */
export function secretKey(target: RecordedTarget): string {
  const source = target.name?.trim() || target.selector
  const slug = source
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase()
  return slug || "SECRET"
}

/** Secret fields in the flow, deduped by {@link secretKey} — what replay must be given. */
export function requiredSecrets(flow: RecordedFlow): string[] {
  const keys = flow.steps
    .filter((s): s is FillStep => s.act === "fill" && s.secret === true)
    .map((s) => secretKey(s.target))
  return [...new Set(keys)]
}

/**
 * Resolve a recorded `url` for replay. Navigations are captured absolute, so
 * this only has to rescue a relative one (hand-edited flows, exports round-
 * tripped through JSON) by resolving it against the flow's base.
 */
export function resolveStepUrl(flow: RecordedFlow, url: string): string {
  try {
    return new URL(url).toString()
  } catch {
    try {
      return new URL(url, flow.baseUrl).toString()
    } catch {
      return url
    }
  }
}
