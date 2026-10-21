import type {
  FillStep,
  RecordedFlow,
  RecordedStep,
  RecordedTarget,
  SelectStep,
} from "@cognia/plugin-contract/lib/browser/recording/protocol"
export type {
  ClickStep,
  DoubleClickStep,
  FillStep,
  HoverStep,
  NavigateStep,
  PressKeyStep,
  RecordedFlow,
  RecordedStep,
  RecordedTarget,
  ScrollStep,
  SelectStep,
  WaitForStep,
} from "@cognia/plugin-contract/lib/browser/recording/protocol"

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
