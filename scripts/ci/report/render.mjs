#!/usr/bin/env node
/**
 * Compose the CI report markdown.
 *
 * One renderer feeds both delivery paths — the job summary and the PR comment
 * — so the two can never disagree about what the run found.
 *
 * Every section degrades to an explicit "not available" line rather than
 * vanishing. A missing section reads as "nothing to report" when it usually
 * means the producing job never ran, which is the more important fact.
 */

import { formatBytes } from "./bundle.mjs"

/**
 * Stable marker used to find and update this comment on re-runs instead of
 * posting a new one each time.
 */
export const COMMENT_MARKER = "<!-- cognia-ci-report -->"

/** Truncate a list, appending an honest "and N more" line. Pure. */
export function truncate(items, limit) {
  if (items.length <= limit) return { shown: items, hidden: 0 }
  return { shown: items.slice(0, limit), hidden: items.length - limit }
}

/** Collapse a multi-line error to one readable line. Pure. */
export function oneLine(text, max = 160) {
  const flat = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const secs = (n) => `${Number(n ?? 0).toFixed(1)}s`
const ms = (n) => `${(Number(n ?? 0) / 1000).toFixed(1)}s`

/** @param {{ jest?: object }} data */
export function renderJest(jest) {
  if (!jest) return ["### Jest", "", "_No JUnit output found — the shards did not report._", ""]

  const lines = [
    "### Jest",
    "",
    `**${jest.passed}** passed · **${jest.failed.length}** failed · ` +
      `**${jest.skipped}** skipped · ${jest.suites} suite(s) · ${secs(jest.totalTime)} total`,
    "",
  ]

  if (jest.failed.length) {
    const { shown, hidden } = truncate(jest.failed, 20)
    lines.push("<details open><summary>Failed tests</summary>", "")
    for (const f of shown) lines.push(`- \`${f.suite}\` › ${f.name}`, `  - ${oneLine(f.message)}`)
    if (hidden) lines.push(`- …and ${hidden} more`)
    lines.push("", "</details>", "")
  }

  if (jest.slowest?.length) {
    lines.push(
      "<details><summary>Slowest suites</summary>",
      "",
      "| Suite | Time | Tests |",
      "| --- | --: | --: |",
      ...jest.slowest.map((s) => `| \`${s.suite}\` | ${secs(s.time)} | ${s.tests} |`),
      "",
      "</details>",
      ""
    )
  }
  return lines
}

/** @param {object} pw */
export function renderPlaywright(pw) {
  if (!pw) return ["### Playwright", "", "_No Playwright report found._", ""]

  const lines = [
    "### Playwright",
    "",
    `**${pw.total - pw.failed.length - pw.skipped}** passed · ` +
      `**${pw.failed.length}** failed · **${pw.flaky.length}** flaky · ` +
      `**${pw.skipped}** skipped`,
    `First-pass ${pw.firstPassRate === null || pw.firstPassRate === undefined ? "—" : `${pw.firstPassRate.toFixed(2)}%`} · ` +
      `Flaky rate ${pw.flakyRate === null || pw.flakyRate === undefined ? "—" : `${pw.flakyRate.toFixed(2)}%`} · ` +
      `P95 ${ms(pw.p95Duration)}`,
    "",
  ]

  if (pw.trend?.hasBase) {
    const label = {
      firstPassRate: "First-pass rate",
      flakyRate: "Flaky rate",
      p95Duration: "P95 duration",
    }
    const value = (metric, number) =>
      metric === "p95Duration" ? ms(number) : `${Number(number).toFixed(2)}%`
    const delta = (metric, number) => {
      if (number === null || number === undefined) return "—"
      const rendered = metric === "p95Duration" ? ms(number) : Number(number).toFixed(2)
      return number > 0 ? `+${rendered}` : rendered
    }
    lines.push(
      "| Metric | Trunk baseline | This run | Δ |",
      "| --- | --: | --: | --: |",
      ...pw.trend.metrics.map(
        (metric) =>
          `| ${label[metric.key] ?? metric.key} | ${value(metric.key, metric.from)} | ` +
          `${value(metric.key, metric.to)} | ${delta(metric.key, metric.delta)} |`
      ),
      ""
    )
  }

  if (pw.failed.length) {
    const { shown, hidden } = truncate(pw.failed, 20)
    lines.push("<details open><summary>Failed specs</summary>", "")
    for (const t of shown) {
      lines.push(`- \`${t.file}\` › ${t.title} (${t.project})`)
      if (t.error) lines.push(`  - ${oneLine(t.error)}`)
    }
    if (hidden) lines.push(`- …and ${hidden} more`)
    lines.push("", "</details>", "")
  }

  if (pw.flaky.length) {
    lines.push(
      "<details open><summary>Flaky — passed only on retry</summary>",
      "",
      ...pw.flaky.map((t) => `- \`${t.file}\` › ${t.title} (${t.attempts} attempts)`),
      "",
      "</details>",
      ""
    )
  }
  return lines
}

/** @param {object} diff from coverage.diffCoverage */
export function renderCoverage(diff) {
  if (!diff) return ["### Coverage", "", "_No coverage data in this run._", ""]

  const pct = (v) => (v === null || v === undefined ? "—" : `${v.toFixed(2)}%`)
  const delta = (v) => {
    if (v === null || v === undefined) return "—"
    if (v === 0) return "±0.00"
    return `${v > 0 ? "🔼 +" : "🔽 "}${v.toFixed(2)}`
  }

  if (!diff.hasBase) {
    return [
      "### Coverage",
      "",
      "_No baseline run on the trunk branch to compare against._",
      "",
      "| Metric | Coverage |",
      "| --- | --: |",
      ...Object.entries(diff.current.metrics).map(([k, m]) => `| ${k} | ${pct(m.pct)} |`),
      "",
    ]
  }

  return [
    "### Coverage",
    "",
    "| Metric | Base | This run | Δ |",
    "| --- | --: | --: | --: |",
    ...diff.metrics.map((m) => `| ${m.key} | ${pct(m.from)} | ${pct(m.to)} | ${delta(m.delta)} |`),
    "",
  ]
}

/** @param {object} diff from bundle.diffBundle */
export function renderBundle(diff) {
  if (!diff) return ["### Bundle size", "", "_The build job produced no measurement._", ""]

  const show = (key, value) => (key === "fileCount" ? String(value) : formatBytes(value))

  if (!diff.hasBase) {
    return [
      "### Bundle size",
      "",
      "_No baseline run on the trunk branch to compare against._",
      "",
      `Total ${formatBytes(diff.current.totalBytes)} · JS ${formatBytes(diff.current.jsBytes)} · ` +
        `${diff.current.fileCount} files`,
      "",
    ]
  }

  return [
    "### Bundle size",
    "",
    "| Metric | Base | This run | Δ |",
    "| --- | --: | --: | --: |",
    ...diff.metrics.map(
      (m) =>
        `| ${m.key} | ${show(m.key, m.from)} | ${show(m.key, m.to)} | ` +
        `${show(m.key, m.delta)}${m.percent === null ? "" : ` (${m.percent >= 0 ? "+" : ""}${m.percent.toFixed(1)}%)`} |`
    ),
    "",
  ]
}

/**
 * Assemble the whole report. Pure.
 *
 * @param {{ jest?: object, playwright?: object, coverage?: object, bundle?: object, meta?: { sha?: string, runUrl?: string, conclusion?: string } }} data
 * @returns {string}
 */
export function renderReport(data = {}) {
  const meta = data.meta ?? {}
  const head = [
    COMMENT_MARKER,
    "## CI report",
    "",
    [
      meta.conclusion ? `**${meta.conclusion}**` : null,
      meta.sha ? `commit \`${meta.sha.slice(0, 7)}\`` : null,
      meta.runUrl ? `[run log](${meta.runUrl})` : null,
    ]
      .filter(Boolean)
      .join(" · "),
    "",
  ]

  return [
    ...head,
    ...renderJest(data.jest),
    ...renderPlaywright(data.playwright),
    ...renderCoverage(data.coverage),
    ...renderBundle(data.bundle),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
    .concat("\n")
}

export { ms }
