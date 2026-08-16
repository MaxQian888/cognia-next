/**
 * Unified "report a problem" model.
 *
 * Every surface that lets a user hand a problem to a maintainer — the Support
 * Agent strip in chat, the mobile Feedback page, the full-page error boundary,
 * a notification-center row, the tray — used to assemble its own text blob and
 * open its own issue link. This module is the one place that decides *what* a
 * report contains (sections) and *where* it can go (channels).
 *
 * Both lists are registries so a plugin or a later subsystem can contribute a
 * section (e.g. "workflow run trace") or a channel (e.g. "send to team inbox")
 * without touching the dialog. Nothing here touches React or the DOM.
 */

/** Which UI surface asked for the report. Drives telemetry + section defaults. */
export type SupportReportSurface = "chat" | "mobile" | "error-page" | "notification" | "tray"

/** Serialisable error facts — a `DOMException`, `Error`, or boundary digest. */
export interface SupportReportError {
  name: string
  message: string
  stack?: string
  digest?: string
}

/** A structured `CogniaDiagnostic` projected down to what a report needs. */
export interface SupportReportDiagnostic {
  code: string
  source?: string
  message?: string
  meta?: Record<string, unknown>
}

/**
 * Everything the calling surface knows at the moment the report is requested.
 * Sections read from this; anything a section needs that is not here it reads
 * live from the runtime (diagnostics snapshot, recent errors, crash reports).
 */
export interface SupportReportContext {
  surface: SupportReportSurface
  /** Free text typed by the user. */
  description?: string
  error?: SupportReportError | null
  diagnostic?: SupportReportDiagnostic | null
  /** `ErrorCategory` from `lib/error/classify-error`, when the boundary knows it. */
  category?: string
  route?: string | null
  locale?: string
  sessionId?: string
  /** Redacted, model-reasoning-free summary of the Support conversation. */
  conversationSummary?: string
}

export interface SupportReportSectionSpec {
  /** Stable id — becomes the section key in `SupportReport.sectionIds`. */
  id: string
  /** i18n key under `support.report.section.` for the checklist label. */
  labelKey: string
  /** i18n key under `support.report.section.` for the checklist hint. */
  descriptionKey: string
  /** Markdown `###` heading in the assembled report (English — the audience is maintainers). */
  heading: string
  /**
   * `true` — always included and not offered as a checkbox (app version, the
   * user's own description). `false` — offered as a toggle.
   */
  pinned: boolean
  /** Initial checkbox state for non-pinned sections. */
  defaultIncluded: boolean
  /** Locally derived data: gets a "redacted" badge and the PII gate. */
  sensitive: boolean
  /** Can this section say anything for this context? Sync so the dialog can render the list immediately. */
  isAvailable: (ctx: SupportReportContext) => boolean
  /** Body markdown (no heading), or `null` when there is nothing to report. */
  collect: (ctx: SupportReportContext) => Promise<string | null> | string | null
}

export interface SupportReport {
  /** Issue-tracker title. */
  title: string
  markdown: string
  filename: string
  generatedAt: string
  /** Sections that actually contributed a body, in report order. */
  sectionIds: string[]
}

export interface SupportReportChannelSpec {
  id: string
  /** i18n key under `support.report.channel.` */
  labelKey: string
  /** Rendered as the dialog's primary action when true (first primary wins). */
  primary?: boolean
  /** Whether the channel can deliver in the current shell. */
  isAvailable: () => boolean
  deliver: (report: SupportReport) => Promise<void>
}
