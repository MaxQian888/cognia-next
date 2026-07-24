/**
 * The link between a CLI session id and the external agent's own session id.
 *
 * `--resume` / `/resume` load the transcript back into the transcript view, but
 * the external agent had zero memory of any of it: the CLI never recorded which
 * agent-side session the conversation belonged to, so every resume started a
 * fresh `session/new`. The screen showed the whole conversation while the agent
 * could see none of it.
 *
 * Recording the pair makes a real resume possible for agents that advertise
 * `loadSession`, and — just as importantly — lets the ones that don't say so
 * plainly instead of silently forgetting.
 *
 * Stored beside the transcript (`~/.cognia/sessions/<id>.external.json`) so the
 * two are moved, copied and deleted together.
 */
import path from "node:path"

import { SESSIONS_DIR, realTranscriptFs, type TranscriptFs } from "./transcript"

/** What was recorded for a session, when anything was. */
export interface ExternalSessionLink {
  /** The backend id the conversation ran on (`codex`, `claude-code`, …). */
  backend: string
  /** The agent's own session id, to hand back to `session/load`. */
  externalSessionId: string
}

export function externalLinkPath(home: string, sessionId: string): string {
  return path.join(home, SESSIONS_DIR, `${sessionId}.external.json`)
}

/** Record (or overwrite) the link. Best-effort: a read-only home must never
 * break a turn that has already succeeded. */
export function writeExternalLink(
  home: string,
  sessionId: string,
  link: ExternalSessionLink,
  fsx: TranscriptFs = realTranscriptFs
): void {
  const target = externalLinkPath(home, sessionId)
  try {
    fsx.mkdirp(path.dirname(target))
    if (fsx.write) fsx.write(target, JSON.stringify(link))
  } catch {
    // A missing link only costs a resume; losing the turn would cost the work.
  }
}

/** Read the link, or undefined when there is none / it is unreadable. */
export function readExternalLink(
  home: string,
  sessionId: string,
  fsx: TranscriptFs = realTranscriptFs
): ExternalSessionLink | undefined {
  try {
    const raw = fsx.read(externalLinkPath(home, sessionId))
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return undefined
    const { backend, externalSessionId } = parsed as Partial<ExternalSessionLink>
    if (typeof backend !== "string" || typeof externalSessionId !== "string") return undefined
    return { backend, externalSessionId }
  } catch {
    return undefined
  }
}

/**
 * Can this recorded link be resumed on the backend now in use?
 *
 * A link from a different backend is useless — an agent cannot load another
 * agent's session — and saying so is what keeps a cross-backend resume from
 * looking like it worked.
 */
export function isResumableLink(
  link: ExternalSessionLink | undefined,
  backend: string | undefined
): link is ExternalSessionLink {
  return !!link && !!backend && link.backend === backend
}

/**
 * The line to show when a transcript is loaded back but the agent will not have
 * it, or `undefined` when the resume genuinely continues the agent's session.
 *
 * Built-in resumes already behaved this way and said nothing about it; on an
 * external backend it is far more misleading, because the whole point of
 * choosing that agent is that it is the one holding the context.
 */
export function resumeContinuityNotice(
  home: string,
  sessionId: string,
  backend: string | undefined,
  supportsResume: boolean,
  fsx: TranscriptFs = realTranscriptFs
): string | undefined {
  if (!backend || backend === "builtin") return undefined
  const link = readExternalLink(home, sessionId, fsx)
  if (isResumableLink(link, backend) && supportsResume) return undefined
  return `Loaded this transcript, but ${backend} does not have it — the conversation above is not visible to it.`
}
