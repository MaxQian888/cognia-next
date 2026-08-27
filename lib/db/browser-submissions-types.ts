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
