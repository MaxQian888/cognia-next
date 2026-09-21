/**
 * JUnit XML test reports (ADR-0188 B4, DEL-02).
 *
 * Read with `@xmldom/xmldom`, never a hand scanner. The document is parsed
 * strictly: any parser error — a malformed tag, an entity it does not know —
 * refuses the whole report. xmldom never expands a DTD's entities or fetches
 * an external one, so a report cannot pull in a host file or blow up in size.
 *
 * Accepted shapes: a `<testsuites>` root with `<testsuite>` children, or a
 * single `<testsuite>` root; suites may nest. A `<testcase>` is:
 *   - `error` when it has an `<error>` child,
 *   - `failed` when it has a `<failure>` child,
 *   - `skipped` when it has a `<skipped>` child,
 *   - `passed` otherwise.
 * A `<failure>` or `<error>` directly under a suite is a suite error: the
 * suite broke outside any case (a fixture that did not load).
 */

import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom"

import {
  capMessage,
  caseIdOf,
  precheckReport,
  refuseReport,
  tallyTestCases,
  type DeclaredTotals,
  type ParsedTestCase,
  type TestCaseStatus,
  type TestReportParseOptions,
  type TestReportParseResult,
} from "./test-report"

const ELEMENT_NODE = 1

function nameOf(element: XmlElement): string {
  return (element.localName ?? element.nodeName).toLowerCase()
}

function childElements(element: XmlElement): XmlElement[] {
  const out: XmlElement[] = []
  const nodes = element.childNodes
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes.item(i)
    if (node && node.nodeType === ELEMENT_NODE) out.push(node as XmlElement)
  }
  return out
}

function attribute(element: XmlElement, name: string): string | null {
  const value = element.getAttribute(name)
  return value !== null && value.trim().length > 0 ? value.trim() : null
}

function integerAttribute(element: XmlElement, name: string): number | null {
  const value = attribute(element, name)
  if (value === null || !/^\d+$/.test(value)) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function durationMs(element: XmlElement): number | null {
  const value = attribute(element, "time")
  if (value === null) return null
  const seconds = Number(value.replace(/,/g, ""))
  return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null
}

function messageOf(element: XmlElement): string | null {
  return capMessage(attribute(element, "message") ?? element.textContent)
}

function declaredOf(element: XmlElement): DeclaredTotals {
  return {
    tests: integerAttribute(element, "tests"),
    failures: integerAttribute(element, "failures"),
    errors: integerAttribute(element, "errors"),
    skipped: integerAttribute(element, "skipped") ?? integerAttribute(element, "disabled"),
  }
}

/** The root's own totals, or the sum of its top-level suites' when the root states none. */
function rootDeclared(root: XmlElement, suites: readonly XmlElement[]): DeclaredTotals | null {
  const own = declaredOf(root)
  if (own.tests !== null) return own
  if (suites.length === 0) return null
  const each = suites.map(declaredOf)
  const sum = (key: keyof DeclaredTotals): number | null =>
    each.every((d) => d[key] !== null) ? each.reduce((acc, d) => acc + (d[key] ?? 0), 0) : null
  const tests = sum("tests")
  if (tests === null) return null
  return { tests, failures: sum("failures"), errors: sum("errors"), skipped: sum("skipped") }
}

export function parseJUnitReport(
  content: string,
  options: TestReportParseOptions = {}
): TestReportParseResult {
  const refused = precheckReport(content, options)
  if (refused) return refused

  let root: XmlElement | null
  try {
    const parser = new DOMParser({
      onError: (level, message) => {
        if (level !== "warning") throw new Error(message)
      },
    })
    root = parser.parseFromString(content, "text/xml").documentElement
  } catch (error) {
    return refuseReport(
      "REPORT_MALFORMED",
      `the JUnit report is not well-formed XML: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!root) return refuseReport("REPORT_MALFORMED", "the JUnit report has no root element")

  const rootName = nameOf(root)
  let topSuites: XmlElement[]
  if (rootName === "testsuites") {
    topSuites = childElements(root).filter((element) => nameOf(element) === "testsuite")
  } else if (rootName === "testsuite") {
    topSuites = [root]
  } else {
    return refuseReport(
      "REPORT_UNSUPPORTED",
      `a JUnit report's root is <testsuites> or <testsuite>, not <${rootName}>`
    )
  }

  const cases: ParsedTestCase[] = []
  const suiteErrors: string[] = []

  const readCase = (element: XmlElement, suitePath: readonly string[]): void => {
    const name = attribute(element, "name") ?? `(unnamed case ${cases.length + 1})`
    const className = attribute(element, "classname")
    const file = attribute(element, "file")
    const scope = className ?? file ?? (suitePath.length > 0 ? suitePath.join(" ") : null)
    const children = childElements(element)
    const find = (tag: string) => children.find((child) => nameOf(child) === tag)
    const error = find("error")
    const failure = find("failure")
    const skipped = find("skipped")
    let status: TestCaseStatus = "passed"
    let message: string | null = null
    if (error) {
      status = "error"
      message = messageOf(error)
    } else if (failure) {
      status = "failed"
      message = messageOf(failure)
    } else if (skipped) {
      status = "skipped"
      message = messageOf(skipped)
    }
    cases.push({
      id: caseIdOf(scope, name),
      name,
      fullName: name,
      scope,
      file,
      className,
      status,
      message,
      durationMs: durationMs(element),
    })
  }

  const walkSuite = (suite: XmlElement, parentPath: readonly string[]): void => {
    const suiteName = attribute(suite, "name")
    const path = suiteName ? [...parentPath, suiteName] : parentPath
    for (const child of childElements(suite)) {
      const tag = nameOf(child)
      if (tag === "testcase") readCase(child, path)
      else if (tag === "testsuite") walkSuite(child, path)
      else if (tag === "error" || tag === "failure") {
        const where = path.length > 0 ? path.join(" ") : "(suite)"
        suiteErrors.push(`${where}: ${messageOf(child) ?? tag}`)
      }
    }
  }
  for (const suite of topSuites) walkSuite(suite, [])

  return {
    ok: true,
    report: {
      kind: "junit",
      cases,
      totals: tallyTestCases(cases),
      declared: rootDeclared(root, topSuites),
      suiteErrors,
    },
  }
}
