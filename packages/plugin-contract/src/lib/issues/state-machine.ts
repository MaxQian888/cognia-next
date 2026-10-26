/**
 * The plugin contract's share of `lib/issues/state-machine.ts`, which re-exports these.
 */
/** Why a move was denied — keyed for i18n at the UI layer. */
export type IssueMoveDenial =
  /** The row is not a local issue; its owning surface controls its status. */
  | "federated-read-only"
  /** `in_progress` is the runtime's while a run is in flight. */
  | "runtime-owned"
  | "illegal-transition"
