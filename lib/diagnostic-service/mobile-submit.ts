"use client"

/**
 * Submit one mobile crash report to the diagnostic service.
 *
 * Lifted out of `useIncidentSubmission` so the consent panel and automatic
 * submission (`auto-submit.ts`) send a mobile report through one path instead
 * of two copies that drift — the same reason the desktop has exactly one
 * native `crash::submit`.
 *
 * Mobile has no native packager: the Capacitor crash plugin hands back a
 * redacted report object, which goes up as a single `events` part (the kind
 * whose frames the service extracts for grouping), plus the user's typed
 * description as a second, scannable `attachment` part when there is one. The
 * grant comes from the installation identity rather than an identity-provider
 * session, so an ordinary user can submit their own crash without a token.
 * The receipt is written back through the plugin's `markReceipt`, which is
 * what makes the incident stop reading `detected` on the next launch.
 */

import { readMobileCrashReport, recordMobileCrashReceipt } from "@/lib/capacitor/crash-diagnostics"

import { DiagnosticServiceClient, type DiagnosticFetch } from "./client"
import type { StoredDiagnosticConnection } from "./connection"
import {
  exchangeAnonymousGrant,
  loadOrCreateInstallationIdentity,
  type InstallationIdentity,
} from "./installation-identity"

/**
 * A failure raised here (or by the hook around it), carrying the code the
 * panel translates.
 *
 * A bare `Error` would arrive at a `codeOf` with its text in `message` and no
 * `code`, and be flattened into the generic failure — which is how a precise
 * "no service configured" turns into "the submission did not complete".
 */
export class SubmissionCodeError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "SubmissionCodeError"
  }
}

/** Hex SHA-256 over the bytes as sent — the service recomputes and compares. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Seams for the tests; production passes nothing. */
export interface MobileSubmitDeps {
  readMobile?: typeof readMobileCrashReport
  recordMobileReceipt?: typeof recordMobileCrashReceipt
  loadIdentity?: (accountId: string) => Promise<InstallationIdentity | null>
  exchangeGrant?: typeof exchangeAnonymousGrant
  digest?: (bytes: Uint8Array) => Promise<string>
}

export interface MobileSubmitInput {
  connection: StoredDiagnosticConnection
  accountId: string
  /** The plugin's incident id. */
  incidentId: string
  /** The incident's capture source, sent as the exception label. */
  exception: string
  /** Free text the user typed; trimmed, and omitted entirely when blank. */
  description: string
  fetchImpl: DiagnosticFetch
}

export interface MobileSubmitResult {
  uploadedParts: number
  resumedParts: number
  /** Always false: the plugin's report is the whole artifact, no screenshot. */
  screenshotUnavailable: false
  supportCode: string
  clientState: string
}

export async function submitMobileCrashReport(
  input: MobileSubmitInput,
  deps: MobileSubmitDeps = {}
): Promise<MobileSubmitResult> {
  const { connection, accountId, fetchImpl } = input
  const digest = deps.digest ?? sha256Hex
  const identity = await (deps.loadIdentity ?? loadOrCreateInstallationIdentity)(accountId)
  if (!identity) {
    // Honest capability report rather than an opaque signature failure: this
    // WebView is too old for Ed25519.
    throw new SubmissionCodeError("installation_proof_unsupported")
  }
  const grant = await (deps.exchangeGrant ?? exchangeAnonymousGrant)({
    baseUrl: connection.baseUrl,
    tenantId: connection.tenantId,
    projectId: connection.projectId,
    identity,
    fetchImpl,
  })
  const outcome = await (deps.readMobile ?? readMobileCrashReport)(input.incidentId)
  if (outcome.kind !== "ok") throw new SubmissionCodeError("report_not_found")
  const report = outcome.value

  const client = new DiagnosticServiceClient({
    baseUrl: connection.baseUrl,
    grant: () => Promise.resolve(grant.grant),
    fetchImpl,
  })
  const encoder = new TextEncoder()
  const parts: Array<{ bytes: Uint8Array; kind: "events" | "attachment" }> = [
    { bytes: encoder.encode(JSON.stringify(report)), kind: "events" },
  ]
  const description = input.description.trim()
  if (description) {
    parts.push({ bytes: encoder.encode(description), kind: "attachment" })
  }

  const totalBytes = parts.reduce((sum, part) => sum + part.bytes.byteLength, 0)
  const created = await client.createIncident({
    // The report is the artifact; its hash is what makes a retry resume rather
    // than duplicate.
    artifactHash: await digest(parts[0].bytes),
    buildId: report.schemaVersion,
    platform: report.source,
    module: "cognia-mobile",
    exception: input.exception,
    attachmentCount: parts.length,
    eventCount: 1,
    totalBytes,
    largestAttachmentBytes: Math.max(...parts.map((part) => part.bytes.byteLength)),
    largestMinidumpBytes: 0,
    consent: true,
  })
  for (const [index, part] of parts.entries()) {
    await client.uploadPart(
      created.incident.id,
      index + 1,
      part.bytes,
      await digest(part.bytes),
      part.kind
    )
  }
  const receipt = await client.completeUpload(created.incident.id)
  // Writes the receipt back into the plugin's own store, which is what makes
  // the incident's state stop reading `detected` on next launch.
  await (deps.recordMobileReceipt ?? recordMobileCrashReceipt)(
    input.incidentId,
    receipt.supportCode,
    receipt.clientState
  )
  return {
    uploadedParts: parts.length,
    resumedParts: 0,
    screenshotUnavailable: false,
    supportCode: receipt.supportCode,
    clientState: receipt.clientState,
  }
}
