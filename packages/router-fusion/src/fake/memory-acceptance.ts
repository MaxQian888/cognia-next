/**
 * An in-memory AcceptancePort for the offline delegate tests and the labelled
 * mock path. Nothing runs: a script says what the acceptance command "did" on
 * a revision — its exit code and the report file it left — and the port turns
 * that into a report through the same `buildCodeAcceptanceReport` the host
 * uses, so the JUnit/JSON parsers and the DEL-02 rules are exercised end to
 * end. A script may also answer with a hand-made report (a model-level one, a
 * stale revision) to prove the workflow refuses to believe it.
 */

import type { VerificationReport } from "../contracts/schemas"
import {
  buildCodeAcceptanceReport,
  type AcceptanceReportFormat,
  type SandboxTier,
} from "../verify/code-acceptance"
import type { AcceptancePort, AcceptanceRunOutcome } from "../workflows/delegate-ports"

export type MemoryAcceptanceStep =
  | {
      kind: "execution"
      exitCode: number | null
      timedOut?: boolean
      report: { format: AcceptanceReportFormat; content: string | null; truncated?: boolean }
      tier?: SandboxTier
      /** Report about another revision than the one asked for (DEL-03). */
      reportRevision?: string
      requiredTests?: string[]
    }
  | { kind: "raw"; report: VerificationReport }
  | { kind: "refused"; code: string; message?: string }
  | { kind: "throw"; message?: string }

export type MemoryAcceptanceScript = (input: {
  profileId: string
  revision: string
  /** 0-based index of this run on the port. */
  run: number
}) => MemoryAcceptanceStep

export class MemoryAcceptancePort implements AcceptancePort {
  readonly runs: Array<{ profileId: string; revision: string; logicalStepId: string }> = []

  constructor(
    private readonly script: MemoryAcceptanceScript,
    private readonly newId: () => string
  ) {}

  async runProfile(input: {
    runId: string
    logicalStepId: string
    profileId: string
    revision: string
  }): Promise<AcceptanceRunOutcome> {
    const run = this.runs.length
    this.runs.push({
      profileId: input.profileId,
      revision: input.revision,
      logicalStepId: input.logicalStepId,
    })
    const step = this.script({ profileId: input.profileId, revision: input.revision, run })
    switch (step.kind) {
      case "refused":
        return { kind: "refused", code: step.code, message: step.message ?? step.code }
      case "raw":
        return { kind: "report", report: step.report }
      case "throw":
        throw new Error(step.message ?? "the sandbox crashed mid-run")
      case "execution":
        return {
          kind: "report",
          report: buildCodeAcceptanceReport({
            reportId: this.newId(),
            revision: step.reportRevision ?? input.revision,
            tier: step.tier ?? "container",
            exitCode: step.exitCode,
            timedOut: step.timedOut ?? false,
            report: {
              format: step.report.format,
              content: step.report.content,
              truncated: step.report.truncated ?? false,
            },
            requiredTests: step.requiredTests ?? [],
          }),
        }
    }
  }
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export interface JUnitFixtureCase {
  name: string
  classname?: string
  status: "passed" | "failed" | "error" | "skipped"
  message?: string
}

/** A JUnit XML document with one suite, as a test runner writes it. */
export function junitFixture(cases: readonly JUnitFixtureCase[], suite = "fixture"): string {
  const count = (status: JUnitFixtureCase["status"]) =>
    cases.filter((c) => c.status === status).length
  const body = cases
    .map((c) => {
      const attrs = `name="${escapeXml(c.name)}" classname="${escapeXml(c.classname ?? suite)}" time="0.01"`
      if (c.status === "passed") return `    <testcase ${attrs}/>`
      const child =
        c.status === "skipped"
          ? `<skipped message="${escapeXml(c.message ?? "skipped")}"/>`
          : `<${c.status === "failed" ? "failure" : "error"} message="${escapeXml(c.message ?? c.status)}">${escapeXml(c.message ?? "")}</${c.status === "failed" ? "failure" : "error"}>`
      return `    <testcase ${attrs}>${child}</testcase>`
    })
    .join("\n")
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${cases.length}" failures="${count("failed")}" errors="${count("error")}" skipped="${count("skipped")}">`,
    `  <testsuite name="${escapeXml(suite)}" tests="${cases.length}" failures="${count("failed")}" errors="${count("error")}" skipped="${count("skipped")}">`,
    body,
    "  </testsuite>",
    "</testsuites>",
  ].join("\n")
}
