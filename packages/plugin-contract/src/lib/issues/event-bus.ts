/**
 * The plugin contract's share of `lib/issues/event-bus.ts`, which re-exports these.
 */
import type { IssueEvent } from "../../types/issues/index"

export type IssueEventListener = (event: IssueEvent) => void
