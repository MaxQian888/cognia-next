/**
 * Desktop → CLI input-history push (WS4).
 *
 * Projects the desktop's recent composer inputs into the cognia CLI's
 * `~/.cognia/history.json` so the standalone CLI's ↑ recall includes lines the
 * user typed in the app. Uses the shared serializer (history-format.ts) so the
 * file is byte-for-byte what the CLI itself writes.
 */

import { listRecentInputHistory } from "@/lib/db/chat-input-history"

import { HISTORY_FILE_NAME, HISTORY_LIMIT, serializeHistory } from "./history-format"
import { writeCliHomeFile } from "./home"

export interface PushHistoryDeps {
  /** Recent inputs newest-first; defaults to the Dexie reader. */
  list?: (limit: number) => Promise<string[]>
  write?: (fileName: string, content: string, secret: boolean) => Promise<void>
}

/**
 * Write `history.json` to the CLI home. Returns the number of entries written,
 * or 0 when there's no history to push. The Dexie reader returns newest-first;
 * the file format is oldest-first (newest last), so we reverse before writing.
 */
export async function pushHistoryToCli(deps: PushHistoryDeps = {}): Promise<number> {
  const list = deps.list ?? listRecentInputHistory
  const newestFirst = await list(HISTORY_LIMIT)
  if (newestFirst.length === 0) return 0
  const oldestFirst = [...newestFirst].reverse()
  const write = deps.write ?? writeCliHomeFile
  await write(HISTORY_FILE_NAME, serializeHistory(oldestFirst), false)
  return oldestFirst.length
}
