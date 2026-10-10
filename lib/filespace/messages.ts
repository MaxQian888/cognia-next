/**
 * The `filespace.*` message key for each way opening a FileSpace path can fail
 * (ADR-0222) — one table for every surface that reports it: the Files panel,
 * desktop deep links and app-route links. Kept apart from `./open.ts` so the
 * root route can name a failure without bundling the opener's stores.
 */

import type { OpenFileSpacePathResult } from "@/types/filespace"

export type OpenFileSpaceFailure = Exclude<OpenFileSpacePathResult, "opened">

export const OPEN_FAILURE_MESSAGE_KEY: Readonly<Record<OpenFileSpaceFailure, string>> = {
  "not-found": "toast.openFailed.notFound",
  outside: "toast.openFailed.outside",
  "no-backend": "toast.openFailed.noBackend",
  offline: "toast.openFailed.offline",
  "session-changed": "toast.openFailed.sessionChanged",
}
