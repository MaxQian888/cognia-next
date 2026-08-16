/**
 * Report sections: what a support report can contain.
 *
 * Built-ins cover everything the previous per-surface builders assembled by
 * hand (error + stack, runtime snapshot, recent errors, crash summaries, sync
 * state, Support conversation). Anything else registers through
 * {@link registerSupportReportSection} and shows up in the dialog checklist
 * with no further wiring.
 *
 * Heavy or shell-specific readers are imported lazily inside `collect()` so the
 * static error boundary — which also builds reports — does not pull Dexie or
 * the crash-report IPC into its chunk.
 */

import { getRecentErrorLogs } from "@cognia/logging/recent-errors"
import { getLocalRuntimeDiagnostics } from "@/lib/native/local-runtime"
import { isCapacitor, isTauri } from "@/lib/platform/detect"

import { formatDiagnostics, gatherDiagnostics } from "./app-facts"
import type { SupportReportContext, SupportReportSectionSpec } from "./types"

const MAX_RECENT_ERRORS = 20
const MAX_CRASH_REPORTS = 5

function fence(lang: string, body: string): string {
  return ["```" + lang, body, "```"].join("\n")
}

const description: SupportReportSectionSpec = {
  id: "description",
  labelKey: "description.label",
  descriptionKey: "description.description",
  heading: "What happened",
  pinned: true,
  defaultIncluded: true,
  sensitive: false,
  isAvailable: () => true,
  collect: (ctx) => {
    const text = ctx.description?.trim()
    return text && text.length > 0 ? text : null
  },
}

const app: SupportReportSectionSpec = {
  id: "app",
  labelKey: "app.label",
  descriptionKey: "app.description",
  heading: "App",
  pinned: true,
  defaultIncluded: true,
  sensitive: false,
  isAvailable: () => true,
  collect: async () => fence("", formatDiagnostics(await gatherDiagnostics())),
}

const error: SupportReportSectionSpec = {
  id: "error",
  labelKey: "error.label",
  descriptionKey: "error.description",
  heading: "Error",
  pinned: false,
  defaultIncluded: true,
  sensitive: true,
  isAvailable: (ctx) => Boolean(ctx.error),
  collect: (ctx) => {
    if (!ctx.error) return null
    const lines = [`${ctx.error.name}: ${ctx.error.message}`]
    if (ctx.error.stack) lines.push(ctx.error.stack)
    return fence("", lines.join("\n"))
  },
}

const diagnostic: SupportReportSectionSpec = {
  id: "diagnostic",
  labelKey: "diagnostic.label",
  descriptionKey: "diagnostic.description",
  heading: "Diagnostic",
  pinned: false,
  defaultIncluded: true,
  sensitive: true,
  isAvailable: (ctx) => Boolean(ctx.diagnostic),
  collect: (ctx) => {
    if (!ctx.diagnostic) return null
    const lines = [`- Code: ${ctx.diagnostic.code}`]
    if (ctx.diagnostic.source) lines.push(`- Source: ${ctx.diagnostic.source}`)
    if (ctx.diagnostic.message) lines.push(`- Message: ${ctx.diagnostic.message}`)
    if (ctx.diagnostic.meta && Object.keys(ctx.diagnostic.meta).length > 0) {
      lines.push("", fence("json", JSON.stringify(ctx.diagnostic.meta, null, 2)))
    }
    return lines.join("\n")
  },
}

const runtime: SupportReportSectionSpec = {
  id: "runtime",
  labelKey: "runtime.label",
  descriptionKey: "runtime.description",
  heading: "Runtime diagnostics",
  pinned: false,
  defaultIncluded: true,
  sensitive: true,
  isAvailable: () => true,
  collect: async () => {
    const snapshot = await getLocalRuntimeDiagnostics().catch(() => null)
    return snapshot ? fence("json", JSON.stringify(snapshot, null, 2)) : null
  },
}

const recentErrors: SupportReportSectionSpec = {
  id: "recentErrors",
  labelKey: "recentErrors.label",
  descriptionKey: "recentErrors.description",
  heading: "Recent errors",
  pinned: false,
  defaultIncluded: true,
  sensitive: true,
  isAvailable: () => getRecentErrorLogs(1).length > 0,
  collect: () => {
    const recent = getRecentErrorLogs(MAX_RECENT_ERRORS)
    if (recent.length === 0) return null
    return recent
      .map((entry) => `- ${entry.timestamp} [${entry.level}] ${entry.module}: ${entry.message}`)
      .join("\n")
  },
}

const crashReports: SupportReportSectionSpec = {
  id: "crashReports",
  labelKey: "crashReports.label",
  descriptionKey: "crashReports.description",
  heading: "Native crash reports",
  pinned: false,
  defaultIncluded: true,
  sensitive: true,
  isAvailable: () => isTauri(),
  collect: async () => {
    const { listCrashReports } = await import("@/lib/native/crash-reports")
    const reports = await listCrashReports().catch(() => [])
    if (reports.length === 0) return null
    const latest = reports.slice(0, MAX_CRASH_REPORTS)
    const lines = latest.map(
      (r) =>
        `- ${r.capturedAt ?? "unknown time"} · ${r.kind ?? "crash"} · ${r.stem} (${r.sizeBytes} bytes)`
    )
    if (reports.length > latest.length) lines.push(`- … ${reports.length - latest.length} more`)
    return lines.join("\n")
  },
}

const sync: SupportReportSectionSpec = {
  id: "sync",
  labelKey: "sync.label",
  descriptionKey: "sync.description",
  heading: "Sync snapshot",
  pinned: false,
  defaultIncluded: true,
  sensitive: true,
  isAvailable: () => isCapacitor(),
  collect: async () => {
    const { snapshotSyncStates } = await import("@/lib/sync/companion-sync")
    return fence("json", JSON.stringify(snapshotSyncStates(), null, 2))
  },
}

const conversation: SupportReportSectionSpec = {
  id: "conversation",
  labelKey: "conversation.label",
  descriptionKey: "conversation.description",
  heading: "Support conversation",
  pinned: false,
  defaultIncluded: true,
  sensitive: true,
  isAvailable: (ctx) => Boolean(ctx.conversationSummary?.trim()),
  collect: (ctx) => ctx.conversationSummary?.trim() || null,
}

/** Report order. `description` first so a maintainer reads the human part before the dumps. */
export const BUILTIN_SUPPORT_REPORT_SECTIONS: readonly SupportReportSectionSpec[] = [
  description,
  error,
  diagnostic,
  conversation,
  app,
  runtime,
  recentErrors,
  crashReports,
  sync,
]

const registered = new Map<string, SupportReportSectionSpec>()

/**
 * Contribute a section. Registering an id that already exists (built-in or
 * registered) throws — silently shadowing a section would make two plugins
 * fight over the same checkbox. Returns the unregister function.
 */
export function registerSupportReportSection(spec: SupportReportSectionSpec): () => void {
  if (registered.has(spec.id) || BUILTIN_SUPPORT_REPORT_SECTIONS.some((s) => s.id === spec.id)) {
    throw new Error(`Support report section "${spec.id}" is already registered.`)
  }
  registered.set(spec.id, spec)
  return () => {
    if (registered.get(spec.id) === spec) registered.delete(spec.id)
  }
}

/** Every known section, built-ins first, then registrations in registration order. */
export function listSupportReportSections(): SupportReportSectionSpec[] {
  return [...BUILTIN_SUPPORT_REPORT_SECTIONS, ...registered.values()]
}

/** Sections that can say something for `ctx`, in report order. */
export function listAvailableSupportReportSections(
  ctx: SupportReportContext
): SupportReportSectionSpec[] {
  return listSupportReportSections().filter((section) => section.isAvailable(ctx))
}

/** Ids a fresh dialog should start with: everything pinned or default-on. */
export function defaultSupportReportSectionIds(ctx: SupportReportContext): string[] {
  return listAvailableSupportReportSections(ctx)
    .filter((section) => section.pinned || section.defaultIncluded)
    .map((section) => section.id)
}

/** Test-only: drop every registration. */
export function __resetSupportReportSectionsForTesting(): void {
  registered.clear()
}
