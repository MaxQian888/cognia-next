/**
 * Row type for the Browser Companion submission ledger.
 *
 * In its own module, like the collab mirrors, so `lib/db/schema.ts` can
 * declare the table without importing the accessor module — which imports the
 * schema back.
 *
 * ## What is deliberately absent
 *
 * The instruction and the captured page text. Both already live in the session
 * transcript that the submission created, which is the record the user can
 * read, edit and delete through the app. Copying them here would create a
 * second store of the same web content with none of the same controls, and the
 * side panel — the only reader — never displays them.
 */
import type { BrowserCaptureMode, BrowserSubmissionStatus } from "@/types/browser-companion"

export interface BrowserSubmissionRow {
  /** Client-minted; also the RPC `Idempotency-Key`. */
  submissionId: string
  /** The browser device that submitted. Scopes every `browser.read-own` read. */
  deviceId: string
  sessionId: string
  /** The session title at submission time, for the recent list. */
  title: string
  /** Hostname only — never the path or the query. */
  sourceHost: string
  /**
   * SHA-256 of the exact captured URL, for the redrive equality check only.
   *
   * The one thing `sourceHost` cannot answer: two pages on the same host are
   * the same host. A retry that carries a different page under an already-used
   * submission id has to be refused, and without this the check falls back to
   * host + title + mode + byte count, which two different paths can match.
   *
   * A digest rather than the URL because of the note above: the path and query
   * are deliberately not stored here, and a digest is not a second copy of
   * them — it only answers "is this the same URL as last time".
   *
   * Optional because a row written before this field existed does not have
   * one; see `describesSameCapture` for what happens then.
   */
  urlFingerprint?: string
  /**
   * The workspace the submission landed in.
   *
   * Recorded so a past submission can be offered as an append target only under
   * the workspace its conversation actually lives in — offering it elsewhere
   * would promise a move the append does not perform.
   *
   * Optional because a row written before this field existed does not have one.
   * Such a row is offered in every workspace, which is what it was before the
   * field existed; narrowing it would need a session read this table is
   * deliberately independent of.
   */
  workspaceId?: string
  /**
   * The delivery target the submission named, as the Host resolved it.
   *
   * Recorded because a redrive has to agree with the original on *where* the
   * work goes, not only on which page it carries. A row created for a new task
   * and a retry naming an append to that same task look identical on every
   * other field, and honouring the second would silently do the opposite of
   * what the second one asked.
   *
   * Optional because a row written before targets existed does not have one;
   * such a row is treated as the default target, which is what it was.
   */
  targetId?: string
  captureMode: BrowserCaptureMode
  /** Bytes of page content sent, for the local diagnostics line. */
  contentBytes: number
  /** Whether anything was cut to fit, so the record does not overstate itself. */
  truncated: boolean
  status: BrowserSubmissionStatus
  /** Machine-readable, set only alongside a `failed` status. */
  errorCode?: string
  submittedAt: number
  updatedAt: number
}
