import type { StrixRun } from "../types"

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * The reason a run stopped, in the reader's language.
 *
 * Runs carry a stable `errorCode` (+ params) and the panel translates it at
 * render time, so a history recorded in English reads in Chinese after a
 * language switch. Rows written before codes existed have only the English
 * `error` string; showing that is better than showing nothing.
 */
export function runErrorText(
  run: Pick<StrixRun, "error" | "errorCode" | "errorParams">,
  t: Translate
) {
  if (run.errorCode) return t(`run.error.${run.errorCode}`, run.errorParams)
  return run.error
}
