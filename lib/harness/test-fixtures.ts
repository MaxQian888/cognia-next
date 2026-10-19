/**
 * Shared builders for the Harness Evolution tests (ADR-0237). Test-only: no
 * production module imports this file.
 */

import type { HarnessEvolutionTask } from "@/types/harness/evolution"
import type { HarnessComponentsV1, HarnessSkillV1 } from "@/types/harness/snapshot"

export function makeSkill(overrides: Partial<HarnessSkillV1> = {}): HarnessSkillV1 {
  return {
    key: "csv-report",
    name: "csv-report",
    description: "Summarise a CSV file into a markdown report.",
    content: "1. Read the CSV.\n2. Run `scripts/summarize.py data.csv`.\n3. Write report.md.",
    resources: [
      {
        path: "scripts/summarize.py",
        kind: "script",
        content: "import csv, sys\nprint(sum(1 for _ in csv.reader(open(sys.argv[1]))))\n",
        encoding: "utf-8",
      },
    ],
    ...overrides,
  }
}

export function makeComponents(overrides: Partial<HarnessComponentsV1> = {}): HarnessComponentsV1 {
  return {
    systemPrompt: "You are a careful analyst. Answer with evidence.",
    guardrails: "Never invent numbers.",
    memory: "Reports go in report.md.",
    toolGuidance: "Prefer Read over Bash for viewing files.",
    skills: [makeSkill()],
    subagents: [
      {
        name: "checker",
        description: "Re-checks a finished report against the data.",
        prompt: "Open report.md and the CSV and list any number that does not match.",
        tools: ["Read"],
      },
    ],
    toolRules: [
      { id: "bash-cap", kind: "call-cap", tool: "Bash", maxCalls: 20, reason: "Stop looping." },
    ],
    ...overrides,
  }
}

export function makeTask(overrides: Partial<HarnessEvolutionTask> = {}): HarnessEvolutionTask {
  return {
    title: "CSV report",
    prompt: "Summarise data.csv into report.md.",
    domain: "office/reports",
    isolation: "files",
    expectedDeliverables: ["report.md"],
    checks: [{ kind: "deliverable-file", path: "report.md" }],
    source: { kind: "custom" },
    inputHash: "task-hash",
    ...overrides,
  }
}
