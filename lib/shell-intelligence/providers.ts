/**
 * Completion sources for the composer's `!` mode, generalized to every command
 * position in the line.
 *
 * The terminal's providers (`lib/terminal/completion/`) each assume the head
 * word is token 0 — true at a PTY prompt, false the moment a line has a pipe in
 * it. This module keeps their DATA (the builtin lists, the in-repo CLI specs,
 * the host's `$PATH` scan, the host's directory listing) and replaces only the
 * position logic, driven by `describeCursor`. Nothing is re-derived: a fix to a
 * spec or a builtin list lands here for free.
 *
 * Every source is gated by what the client can actually reach. Builtins and the
 * CLI specs are static data and answer everywhere, including a standalone
 * browser; `$PATH` and the filesystem need a Host and simply contribute nothing
 * without one. That split is why `static-only` is a useful state rather than a
 * dead feature.
 */

import { dirSeparator, requoteToken } from "@/lib/terminal/completion/path-provider"
import { shellBuiltins } from "@/lib/terminal/completion/shell-builtins"
import { ALL_SPECS, getSpec } from "@/lib/terminal/completion/spec"
import { resolveSpec } from "@/lib/terminal/completion/spec/resolve"
import { shellUsesBackslashEscapes } from "@/lib/terminal/completion/tokenize"
import {
  completeTerminalPaths,
  listTerminalPathExecutables,
  type RemotePathCandidate,
} from "@/lib/terminal/remote-api"
import { isPathLikeToken } from "./lex"
import { describeCursor, type CursorContext } from "./segments"
import type { ShellCompletion, ShellIntelligenceRequest } from "./types"

/** Host-backed lookups, injected so the whole layer is testable without a Host. */
export interface CompletionSources {
  listPathExecutables(options: { prefix: string; limit?: number }): Promise<string[]>
  completePaths(options: {
    cwd: string
    fragment: string
    showHidden?: boolean
    limit?: number
  }): Promise<RemotePathCandidate[]>
}

/** The production sources: both ride the shared transport, so both work remotely. */
export const hostCompletionSources: CompletionSources = {
  listPathExecutables: listTerminalPathExecutables,
  completePaths: completeTerminalPaths,
}

/** How many raw candidates each source contributes before the merge caps them. */
const PER_SOURCE_LIMIT = 40

/** The directory part of a path fragment (trailing separator kept). */
function fragmentDirectory(fragment: string): string {
  const idx = Math.max(fragment.lastIndexOf("/"), fragment.lastIndexOf("\\"))
  return idx < 0 ? "" : fragment.slice(0, idx + 1)
}

/** Case-insensitive prefix match — what every shell's completion does. */
function matchesPrefix(candidate: string, prefix: string): boolean {
  return candidate.toLowerCase().startsWith(prefix.toLowerCase())
}

/** Head-word candidates that need no Host: shell builtins + known CLI names. */
export function staticHeadCandidates(
  prefix: string,
  shellKind: ShellIntelligenceRequest["shell"]["kind"]
): Array<{ name: string; kind: "builtin" | "command"; detail?: string }> {
  if (prefix.length === 0) return []
  const out: Array<{ name: string; kind: "builtin" | "command"; detail?: string }> = []
  for (const name of shellBuiltins(shellKind)) {
    if (matchesPrefix(name, prefix)) out.push({ name, kind: "builtin" })
  }
  // The in-repo CLI specs double as a name list. This is what makes `! kub` →
  // `kubectl` answer on a standalone browser, where the `$PATH` scan cannot run
  // — the same specs that complete the command's flags also know it exists.
  for (const spec of ALL_SPECS) {
    if (matchesPrefix(spec.name, prefix)) {
      out.push({ name: spec.name, kind: "command", detail: spec.description })
    }
  }
  return out
}

/** Host `$PATH` executables for a head word. Silent on any failure. */
async function hostHeadCandidates(
  prefix: string,
  sources: CompletionSources,
  signal: AbortSignal
): Promise<string[]> {
  if (prefix.length === 0 || isPathLikeToken(prefix)) return []
  try {
    const names = await sources.listPathExecutables({ prefix, limit: PER_SOURCE_LIMIT })
    if (signal.aborted || !Array.isArray(names)) return []
    return names
  } catch {
    return []
  }
}

/** Host filesystem candidates for the token under the cursor. */
async function pathCandidates(
  request: ShellIntelligenceRequest,
  cursor: CursorContext,
  sources: CompletionSources,
  signal: AbortSignal
): Promise<ShellCompletion[]> {
  if (!request.cwd) return []
  const fragment = cursor.token.value
  let candidates: RemotePathCandidate[]
  try {
    candidates = await sources.completePaths({
      cwd: request.cwd,
      fragment,
      showHidden: false,
      limit: PER_SOURCE_LIMIT,
    })
  } catch {
    return []
  }
  if (signal.aborted || !Array.isArray(candidates)) return []

  const dirPart = fragmentDirectory(fragment)
  const separator = dirSeparator(fragment, request.shell.kind)
  const out: ShellCompletion[] = []
  for (const candidate of candidates) {
    // A directory keeps its separator so acceptance lands INSIDE it and the
    // next segment can be requested immediately — `./sr` → `./src/`.
    const completed = dirPart + candidate.name + (candidate.isDir ? separator : "")
    if (completed === fragment) continue
    const insertText = requoteToken(completed, request.shell.kind, candidate.isDir)
    out.push({
      label: candidate.name + (candidate.isDir ? separator : ""),
      insertText,
      from: cursor.token.start,
      to: cursor.token.end,
      kind: candidate.isDir ? "directory" : "path",
      ...(candidate.isDir ? { continues: true } : {}),
    })
  }
  return out
}

/** Spec-driven subcommand/flag candidates for an argument position. */
function specCandidates(cursor: CursorContext): ShellCompletion[] {
  const head = cursor.segment.head
  if (!head) return []
  const spec = getSpec(head.value)
  if (!spec) return []
  return resolveSpec(spec, cursor.priorArguments, cursor.token.value).map((candidate) => ({
    label: candidate.name,
    insertText: candidate.name,
    from: cursor.token.start,
    to: cursor.token.end,
    kind: candidate.kind === "option" ? ("option" as const) : ("argument" as const),
    ...(candidate.description ? { detail: candidate.description } : {}),
  }))
}

/**
 * Collect every candidate for the cursor position.
 *
 * Returns raw, unranked candidates — {@link import("./orchestrator")} owns the
 * dedupe, ranking and cap so those rules live in one place and are testable
 * against a hand-built list.
 */
export async function collectCandidates(
  request: ShellIntelligenceRequest,
  sources: CompletionSources,
  signal: AbortSignal
): Promise<ShellCompletion[]> {
  const escapes = shellUsesBackslashEscapes(request.shell.kind)
  const cursor = describeCursor(request.line, request.cursor, { backslashEscapes: escapes })
  if (!cursor) return []

  const hostReachable = request.availability !== "static-only"
  const span = { from: cursor.token.start, to: cursor.token.end }
  const out: ShellCompletion[] = []

  if (cursor.role === "redirect-target") {
    return hostReachable ? pathCandidates(request, cursor, sources, signal) : []
  }

  if (cursor.role === "head") {
    const prefix = cursor.token.value
    // A head that is visibly a path (`./script.sh`, `~/bin/x`) is completed as
    // one — that is how you run a script that is not on `$PATH`.
    if (isPathLikeToken(prefix)) {
      return hostReachable ? pathCandidates(request, cursor, sources, signal) : []
    }
    for (const candidate of staticHeadCandidates(prefix, request.shell.kind)) {
      out.push({
        label: candidate.name,
        insertText: candidate.name,
        ...span,
        kind: candidate.kind,
        ...(candidate.detail ? { detail: candidate.detail } : {}),
      })
    }
    if (hostReachable) {
      for (const name of await hostHeadCandidates(prefix, sources, signal)) {
        out.push({ label: name, insertText: name, ...span, kind: "command" })
      }
    }
    return out
  }

  // An argument: the head's spec first (it knows what the flag MEANS), then the
  // filesystem, which is the fallback for everything a spec cannot model.
  out.push(...specCandidates(cursor))
  if (hostReachable) {
    out.push(...(await pathCandidates(request, cursor, sources, signal)))
  }
  return out
}
