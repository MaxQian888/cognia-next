/**
 * The plugin contract's share of `lib/skills/built-in/types.ts`, which re-exports these.
 */
/**
 * Result envelope returned by `runBuiltInSkill`. Three terminal shapes:
 *
 *   - `ok`              — skill executed; `data` is the JSON-safe result.
 *   - `pending_hitl`    — confirm card was sent; assistant should wait for
 *                         the callback. `bindingId` is the binding row id
 *                         the bus will resolve on callback arrival.
 *   - `denied`          — gate fired before execution; `reason` is a
 *                         machine-readable token (`pii_blocked`,
 *                         `not_allowed_for_channel`, `destructive_opt_in_required`).
 *   - `error`           — execution attempted but failed; `message` carries
 *                         the (PII-redacted) error.
 */
export type BuiltInSkillResult =
  | { status: "ok"; data: unknown }
  | { status: "pending_hitl"; bindingId: string; surfaceId: string }
  | { status: "denied"; reason: string; message: string }
  | { status: "error"; message: string }
