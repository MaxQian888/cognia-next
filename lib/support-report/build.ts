/**
 * Assemble a support report from the chosen sections.
 *
 * Every section body — including the user's own words — goes through
 * `redactText` and is then re-checked with `hasNoLeakingPii` before it is
 * allowed into the report. A section that still leaks after redaction fails
 * the whole build rather than shipping a partially-scrubbed document: the
 * caller shows an error, nothing leaves the device.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { APP_VERSION } from "@/lib/app-version"

import { listAvailableSupportReportSections } from "./sections"
import type { SupportReport, SupportReportContext, SupportReportSectionSpec } from "./types"

/** Per-section cap so one runaway dump (a 200k stack) cannot crowd out the rest. */
export const MAX_SECTION_CHARS = 8_000
const MAX_TITLE_CHARS = 100

export interface BuildSupportReportOptions {
  context: SupportReportContext
  /**
   * Section ids to include. Pinned sections are always included regardless of
   * this list; unknown ids are ignored. Defaults to every available section.
   */
  sectionIds?: readonly string[]
  /** Injected for tests; production uses the registry. */
  sections?: readonly SupportReportSectionSpec[]
  /** ISO timestamp — injected so tests are deterministic. */
  generatedAt?: string
}

/** Sanitise a free-text fragment: redact, cap, and refuse to leak. */
function scrub(text: string, cap: number): string {
  const redacted = redactText(text).redacted.slice(0, cap)
  if (!hasNoLeakingPii(redacted)) {
    throw new Error("Support report still contains sensitive data after redaction.")
  }
  return redacted
}

/** Issue title: the failure if we have one, else the first line of the description. */
export function deriveSupportReportTitle(ctx: SupportReportContext): string {
  const tag = ctx.category ?? ctx.diagnostic?.source ?? ctx.surface
  if (ctx.error?.message) return `[${tag}] ${ctx.error.message}`.slice(0, MAX_TITLE_CHARS)
  if (ctx.diagnostic?.code) return `[${tag}] ${ctx.diagnostic.code}`.slice(0, MAX_TITLE_CHARS)
  const firstLine = ctx.description?.trim().split(/\r?\n/, 1)[0]?.trim()
  if (firstLine) return firstLine.slice(0, MAX_TITLE_CHARS)
  return "Cognia support report"
}

export async function buildSupportReport({
  context,
  sectionIds,
  sections = listAvailableSupportReportSections(context),
  generatedAt = new Date().toISOString(),
}: BuildSupportReportOptions): Promise<SupportReport> {
  const wanted = sectionIds ? new Set(sectionIds) : null
  const chosen = sections.filter(
    (section) =>
      section.isAvailable(context) && (section.pinned || !wanted || wanted.has(section.id))
  )

  const header = [
    "## Cognia support report",
    "",
    `- App version: ${APP_VERSION}`,
    `- Generated: ${generatedAt}`,
    `- Surface: ${context.surface}`,
    ...(context.category ? [`- Category: ${context.category}`] : []),
    ...(context.route ? [`- Route: ${context.route}`] : []),
    ...(context.locale ? [`- Locale: ${context.locale}`] : []),
    ...(context.error?.digest ? [`- Error ID: ${context.error.digest}`] : []),
  ]

  const bodies: string[] = []
  const sectionIdsOut: string[] = []
  for (const section of chosen) {
    const raw = await section.collect(context)
    if (!raw || raw.trim().length === 0) continue
    bodies.push(`### ${section.heading}`, "", scrub(raw, MAX_SECTION_CHARS), "")
    sectionIdsOut.push(section.id)
  }

  const markdown = [...header, "", ...bodies].join("\n").trimEnd() + "\n"
  return {
    title: scrub(deriveSupportReportTitle(context), MAX_TITLE_CHARS),
    markdown,
    filename: `cognia-support-report-${generatedAt.slice(0, 10)}.md`,
    generatedAt,
    sectionIds: sectionIdsOut,
  }
}
