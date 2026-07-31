#!/usr/bin/env node
/**
 * JUnit XML → structured test results.
 *
 * `jest.config.ts` already emits `jest-junit` output (one file per CI shard,
 * named via `JEST_JUNIT_OUTPUT_NAME`), and the shards are already uploaded as
 * artifacts. Nothing read them. This module is what makes them useful: the
 * failed-test list and the slowest-suite ranking that the report workflow
 * turns into a PR comment.
 *
 * Zero dependencies on purpose. The repo has no XML parser and adding one
 * would mean touching pnpm-lock.yaml; jest-junit's output is a narrow,
 * predictable subset of JUnit, so a focused parser is both smaller and
 * easier to pin with tests than a general one would be.
 */

/** The five predefined XML entities, plus numeric escapes. */
export function decodeXml(value) {
  return value
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
}

/**
 * Parse an XML open-tag's attribute list. Pure.
 * @param {string} source the text between the tag name and the closing `>`
 * @returns {Record<string, string>}
 */
export function parseAttributes(source) {
  const attrs = {}
  for (const m of source.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]] = decodeXml(m[2])
  }
  return attrs
}

/**
 * Parse one JUnit XML document. Pure.
 *
 * @param {string} xml
 * @returns {{ cases: Array<{ suite: string, name: string, time: number, status: "passed"|"failed"|"skipped", message: string }> }}
 */
export function parseJUnit(xml) {
  const cases = []
  // Walk testcase elements, self-closing or with a body. The body is what
  // carries <failure>/<error>/<skipped>, so it decides the status.
  const re = /<testcase\b([^>]*?)(\/)?>/g
  let match
  while ((match = re.exec(xml)) !== null) {
    const attrs = parseAttributes(match[1])
    const selfClosing = Boolean(match[2])
    let body = ""
    if (!selfClosing) {
      const end = xml.indexOf("</testcase>", re.lastIndex)
      body = end === -1 ? "" : xml.slice(re.lastIndex, end)
    }

    let status = "passed"
    let message = ""
    const failure = body.match(/<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/)
    if (failure) {
      status = "failed"
      const failAttrs = parseAttributes(failure[2] ?? "")
      message = (failAttrs.message || decodeXml(failure[3] ?? "")).trim()
    } else if (/<skipped\b/.test(body)) {
      status = "skipped"
    }

    cases.push({
      suite: attrs.classname ?? attrs.file ?? "",
      name: attrs.name ?? "",
      time: Number(attrs.time ?? 0),
      status,
      message,
    })
  }
  return { cases }
}

/**
 * Fold many shard documents into one report. Pure.
 *
 * @param {string[]} documents raw XML, one per shard
 * @param {{ slowest?: number }} [options]
 */
export function summarizeJUnit(documents, options = {}) {
  const slowestCount = options.slowest ?? 10
  const cases = documents.flatMap((doc) => parseJUnit(doc).cases)

  const failed = cases.filter((c) => c.status === "failed")
  const skipped = cases.filter((c) => c.status === "skipped")

  // Suite duration is the sum of its cases: with sharding, one suite's cases
  // all land on the same shard, so this is the suite's real wall clock.
  const bySuite = new Map()
  for (const c of cases) {
    const entry = bySuite.get(c.suite) ?? { suite: c.suite, time: 0, tests: 0 }
    entry.time += c.time
    entry.tests += 1
    bySuite.set(c.suite, entry)
  }
  const slowest = [...bySuite.values()].sort((a, b) => b.time - a.time).slice(0, slowestCount)

  return {
    total: cases.length,
    passed: cases.length - failed.length - skipped.length,
    failed,
    skipped: skipped.length,
    suites: bySuite.size,
    totalTime: cases.reduce((sum, c) => sum + c.time, 0),
    slowest,
  }
}
