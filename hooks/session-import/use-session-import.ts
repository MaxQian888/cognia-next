"use client"

// State machine for the external-agent session-history import flow:
//   idle → scanning → list → importing → done | error
//
// Two entry paths converge on the same `list` state:
//   - scan()        desktop auto-scan of every registered source
//   - pickFiles()   file/folder picker (web + desktop fallback)
// The parsed `SessionScanInput` is retained so the selected refs can be
// re-parsed on import without re-reading disk. Mirrors `useChatImport`.

import { useCallback, useMemo, useRef, useState } from "react"
import { pickAndReadFiles } from "@/lib/files/file-bridge"
import { createLogger } from "@/lib/logging"
import {
  detectSourceForFiles,
  importSessions as importSessionsDefault,
  scanAllSources as scanAllSourcesDefault,
  listSessionsForSource as listSessionsForSourceDefault,
  resolveScanInput as resolveScanInputDefault,
  type PickedSessionFile,
  type SessionRef,
  type SessionScanError,
  type SessionScanInput,
  type SessionSummary,
} from "@/lib/session-import"

const log = createLogger("session-import")

export type SessionImportState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "list"; summaries: SessionSummary[]; warnings?: SessionScanError[] }
  | { status: "importing" }
  | { status: "done"; sessionsAdded: number; messagesAdded: number }
  | { status: "error"; message: string }

/** Stable key for a summary (source + on-disk locator). */
export function summaryKey(ref: SessionRef): string {
  return `${ref.sourceId}::${ref.locator}`
}

export interface UseSessionImportDeps {
  resolveScanInput?: typeof resolveScanInputDefault
  scanAllSources?: typeof scanAllSourcesDefault
  listSessionsForSource?: typeof listSessionsForSourceDefault
  importSessions?: typeof importSessionsDefault
  pick?: typeof pickAndReadFiles
  detect?: typeof detectSourceForFiles
}

export function useSessionImport(deps: UseSessionImportDeps = {}) {
  const resolveScanInput = deps.resolveScanInput ?? resolveScanInputDefault
  const scanAllSources = deps.scanAllSources ?? scanAllSourcesDefault
  const listSessionsForSource = deps.listSessionsForSource ?? listSessionsForSourceDefault
  const importSessions = deps.importSessions ?? importSessionsDefault
  const pick = deps.pick ?? pickAndReadFiles
  const detect = deps.detect ?? detectSourceForFiles

  const [state, setState] = useState<SessionImportState>({ status: "idle" })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const inputRef = useRef<SessionScanInput | null>(null)

  const reset = useCallback(() => {
    setState({ status: "idle" })
    setSelected(new Set())
    inputRef.current = null
  }, [])

  const showList = useCallback(
    (summaries: SessionSummary[], input: SessionScanInput, warnings?: SessionScanError[]) => {
      inputRef.current = input
      // Pre-select everything found — the common case is "import them all".
      setSelected(new Set(summaries.map((s) => summaryKey(s.ref))))
      setState({ status: "list", summaries, ...(warnings?.length ? { warnings } : {}) })
    },
    []
  )

  /** Desktop auto-scan of every source. Per-source failures surface as warnings. */
  const scan = useCallback(async () => {
    setState({ status: "scanning" })
    try {
      const input = await resolveScanInput()
      const { summaries, errors } = await scanAllSources(input)
      showList(summaries, input, errors)
    } catch (err) {
      log.error("session-import-scan-failed", { error: err })
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [resolveScanInput, scanAllSources, showList])

  /** File-picker fallback. Optionally forces a source; else auto-detects. */
  const pickFiles = useCallback(
    async (sourceId?: string) => {
      setState({ status: "scanning" })
      try {
        const picked = await pick({
          multiple: true,
          filters: [{ name: "Agent session", extensions: ["jsonl", "json"] }],
        })
        if (picked.length === 0) {
          setState({ status: "idle" })
          return
        }
        const files: PickedSessionFile[] = picked.map((p) => ({
          name: p.name,
          path: p.path,
          content: p.content,
        }))
        const input = await resolveScanInput({ pickedFiles: files, home: "" })
        const resolvedSource = sourceId ?? detect(files)
        const summaries = resolvedSource ? await listSessionsForSource(resolvedSource, input) : []
        if (summaries.length === 0) {
          setState({ status: "error", message: "unrecognized" })
          return
        }
        showList(summaries, input)
      } catch (err) {
        log.error("session-import-pick-failed", { error: err })
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      }
    },
    [pick, resolveScanInput, detect, listSessionsForSource, showList]
  )

  const toggle = useCallback((key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const setAll = useCallback((on: boolean) => {
    setState((s) => {
      if (s.status === "list") {
        setSelected(on ? new Set(s.summaries.map((x) => summaryKey(x.ref))) : new Set())
      }
      return s
    })
  }, [])

  /** Import the currently-selected sessions into the given workspace. */
  const importSelected = useCallback(
    async (projectId?: string) => {
      const input = inputRef.current
      if (!input || state.status !== "list") return
      const refs = state.summaries.filter((s) => selected.has(summaryKey(s.ref))).map((s) => s.ref)
      if (refs.length === 0) return
      setState({ status: "importing" })
      try {
        const counts = await importSessions(refs, input, projectId)
        setState({ status: "done", sessionsAdded: counts.sessions, messagesAdded: counts.messages })
      } catch (err) {
        log.error("session-import-apply-failed", { error: err })
        setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      }
    },
    [state, selected, importSessions]
  )

  const selectedCount = useMemo(() => selected.size, [selected])

  return { state, selected, selectedCount, scan, pickFiles, toggle, setAll, importSelected, reset }
}
