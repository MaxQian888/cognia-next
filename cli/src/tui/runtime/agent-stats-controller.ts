/**
 * `/agent-stats` controller — the CLI analog of the desktop session-import
 * dialog, but read-only + statistical. Scans the on-disk histories of Claude
 * Code / Codex / OpenCode via `lib/session-import` (a Node `SessionFs` + a Node
 * `node:sqlite` OpenCode reader, since the desktop paths are Tauri-only), parses
 * them, derives the token/cost usage the adapters stamped onto each turn, builds
 * the aggregate model, and opens the panel.
 *
 * Never throws — a failing/absent source degrades to fewer rows. Data flow
 * mirrors {@link runLimits}: fetch → build → dispatch OVERLAY_OPEN.
 */
import {
  listAllSessions,
  parseSessions,
  type ImportedConversation,
  type SessionFs,
  type SessionRef,
  type SessionScanInput,
  type SessionSummary,
} from "@/lib/session-import"
import type { VendorRoots } from "@/lib/agent-roots"
import { deriveImportedUsageRows } from "@/lib/session-import/usage"
import { setOpencodeReader } from "@/lib/session-import/adapters/opencode-db"

import type { TuiAction } from "../state/types"
import { nodeSessionFs, nodeVendorRoots } from "./node-session-fs"
import { isNodeSqliteAvailable, nodeOpencodeReader } from "./node-opencode-reader"
import { buildAgentStats, sourceOfSessionId, type ConvWithUsage } from "./agent-stats-model"

export interface AgentStatsDeps {
  dispatch: (action: TuiAction) => void
  /** OS home (`~`) — `~/.claude` and `~/.codex` hang off this. */
  osHome: string
  signal?: AbortSignal
  /** Cap on conversations parsed per open (disclosed when it truncates). */
  maxConversations?: number
  // ── seams (tests) ──────────────────────────────────────────────────────────
  fs?: SessionFs
  /** Override the env-derived vendor roots. */
  roots?: VendorRoots
  installOpencodeReader?: () => void
  listSessions?: (input: SessionScanInput) => Promise<SessionSummary[]>
  parse?: (refs: SessionRef[], input: SessionScanInput) => Promise<ImportedConversation[]>
}

const DEFAULT_MAX = 500

export async function runAgentStats(deps: AgentStatsDeps): Promise<void> {
  const fs = deps.fs ?? nodeSessionFs()
  // The desktop OpenCode reader is a Tauri command; give the CLI a Node one.
  ;(deps.installOpencodeReader ?? (() => setOpencodeReader(nodeOpencodeReader)))()

  // Roots from the CLI's own env — `$CODEX_HOME` etc. relocate these trees and
  // only this process can see them (the desktop asks Rust instead).
  const input: SessionScanInput = {
    fs,
    home: deps.osHome,
    roots: deps.roots ?? nodeVendorRoots(deps.osHome),
  }

  let summaries: SessionSummary[] = []
  try {
    summaries = await (deps.listSessions ?? listAllSessions)(input)
  } catch {
    summaries = []
  }
  if (deps.signal?.aborted) return
  if (summaries.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "No external agent sessions found (looked in ~/.claude, ~/.codex, and OpenCode's store).",
    })
    return
  }

  const notes: string[] = []
  // Older Node (< 22.5) has no `node:sqlite`, so the OpenCode reader silently
  // yields nothing — disclose the skip instead of underreporting.
  if (!deps.installOpencodeReader && !(await isNodeSqliteAvailable())) {
    notes.push("OpenCode sessions skipped: this Node runtime lacks node:sqlite (need Node 22.5+).")
  }
  const cap = deps.maxConversations ?? DEFAULT_MAX
  let refs: SessionRef[] = summaries.map((s) => s.ref)
  if (refs.length > cap) {
    notes.push(`Analyzed the ${cap} most recent of ${refs.length} conversations.`)
    refs = refs.slice(0, cap)
  }

  let convs: ImportedConversation[] = []
  try {
    convs = await (deps.parse ?? parseSessions)(refs, input)
  } catch {
    convs = []
  }
  if (deps.signal?.aborted) return

  const items: ConvWithUsage[] = convs.map((conv) => ({
    source: sourceOfSessionId(conv.session.id),
    conv,
    usageRows: deriveImportedUsageRows(conv.messages, { fallbackModel: conv.session.model }),
  }))

  const { overview, rows } = buildAgentStats(items, { notes })
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: { kind: "agentStats", overview, rows, items, index: 0 },
  })
}
