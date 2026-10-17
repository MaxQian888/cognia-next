/**
 * The CLI's `working_set` store: one JSON file per session under
 * `<home>/working-sets/<sessionId>.json`.
 *
 * The shared tool reads and writes the working set on the Dexie chat-session
 * row, but a CLI session lives in the CLI's own session store and never has a
 * Dexie row, so every call failed with "Unknown chat session". This store keeps
 * the same contract — revisioned compare-and-swap, the same validation, PII
 * gate and bounds via `applyWorkingSetMutation` — on disk beside the session.
 *
 * It sits next to `checkpoints/`, not inside `sessions/<id>/`: a directory
 * named after the session id is how the session store recognises a canonical
 * session, so creating one would make a legacy session look canonical.
 *
 * Mutations of one file are serialised in-process — across every store
 * instance, since each tool handle builds its own — so two parallel model calls
 * cannot both pass the CAS check against the same revision. Across processes
 * the session's single-writer lease already rules out two writers.
 */

import fs from "node:fs/promises"
import path from "node:path"

import {
  SESSION_WORKING_SET_CONTRACT_VERSION,
  type SessionWorkingSetV1,
} from "@cognia/agent-config-types/working-set"
import { applyWorkingSetMutation, emptyWorkingSet } from "@/lib/chat/working-set"
import type { WorkingSetMutation } from "@/lib/chat/working-set"
import type { WorkingSetStore } from "@/lib/claude/working-set-tool"

import { workingSetPath } from "./session-store/paths"

/** File-system effects, injectable for tests. */
export interface WorkingSetFs {
  readFile(p: string): Promise<string | null>
  /** Replace atomically (same-directory temp file + rename). */
  writeFileAtomic(p: string, content: string): Promise<void>
}

export const realWorkingSetFs: WorkingSetFs = {
  readFile: async (p) => {
    try {
      return await fs.readFile(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  writeFileAtomic: async (p, content) => {
    await fs.mkdir(path.dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
    try {
      await fs.writeFile(tmp, content)
      await fs.rename(tmp, p)
    } catch (err) {
      await fs.rm(tmp, { force: true })
      throw err
    }
  },
}

function isWorkingSet(value: unknown): value is SessionWorkingSetV1 {
  if (!value || typeof value !== "object") return false
  const v = value as Record<string, unknown>
  return (
    v.contractVersion === SESSION_WORKING_SET_CONTRACT_VERSION &&
    Number.isInteger(v.revision) &&
    (v.revision as number) >= 0 &&
    Array.isArray(v.entries) &&
    typeof v.updatedAt === "number"
  )
}

// Per-file mutation queues, shared by every store in this process.
const queues = new Map<string, Promise<unknown>>()

export interface FileWorkingSetStoreOptions {
  home: string
  fsx?: WorkingSetFs
}

export function createFileWorkingSetStore({
  home,
  fsx = realWorkingSetFs,
}: FileWorkingSetStoreOptions): WorkingSetStore {
  async function read(sessionId: string): Promise<SessionWorkingSetV1> {
    const file = workingSetPath(home, sessionId)
    const raw = await fsx.readFile(file)
    if (raw === null) return emptyWorkingSet()
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new Error(
        `working set file ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    // A damaged file is reported, never silently reset: resetting would drop
    // the user-visible state and restart the revision at 0.
    if (!isWorkingSet(parsed)) throw new Error(`working set file ${file} has an unknown shape`)
    return parsed
  }

  function mutate(mutation: WorkingSetMutation): Promise<SessionWorkingSetV1> {
    let file: string
    try {
      file = workingSetPath(home, mutation.sessionId)
    } catch (err) {
      return Promise.reject(err)
    }
    const run = async () => {
      const next = applyWorkingSetMutation(await read(mutation.sessionId), mutation)
      await fsx.writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`)
      return next
    }
    const prior = queues.get(file) ?? Promise.resolve()
    const result = prior.then(run, run)
    const tail = result.catch(() => {})
    queues.set(file, tail)
    void tail.then(() => {
      if (queues.get(file) === tail) queues.delete(file)
    })
    return result
  }

  return { read, mutate }
}
