/**
 * Subagents contributed by the plugin. Registered into the subagent-registry
 * on enable; `resolveAllSubagents({ context: "team" })` unions them with the
 * host's built-ins and namespaces them as `<pluginId>:<id>` so a teammate or a
 * role character (running via the agent.turn path) can dispatch them as Task
 * subagents for focused, read-only analysis.
 *
 * Subagents declare standard SDK tool names; these two are read-only by design
 * (no Edit/Write) — they reason and report, while the actual edits flow through
 * the `refactorer`/`tester` roles on the agent.turn node.
 */

import { defineSubagent } from "@cognia/plugin-sdk"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"

const GO_ANALYZER = defineSubagent({
  id: "go-analyzer",
  name: "Go Analyzer",
  description:
    "Read-only deep analysis of a Go package: layering, coupling, error handling, and test gaps. Reports findings; never edits.",
  prompt:
    "You are a Go static-analysis specialist. Given a package or path, read the code and report, structured by severity: layering violations (logic in handlers, leaked dependencies, package cycles), error-handling problems (swallowed errors, missing wrapping, ignored context), concurrency risks, and test gaps. Quote file:line for each finding. You are READ-ONLY — never modify files; produce a findings report the refactorer can act on.",
  tools: ["Read", "Grep", "Glob", "Bash"],
  model: "sonnet",
  effort: "high",
})

const DIFF_REVIEWER = defineSubagent({
  id: "diff-reviewer",
  name: "Diff Reviewer",
  description:
    "Read-only review of a working-tree diff for regressions, layering violations, and over-engineering.",
  prompt:
    "You review a Git diff with senior-engineer pragmatism. Inspect `git diff` (and surrounding context as needed) and report blocking issues by severity: Critical (real bugs, security, behaviour changes), Important (layering violations, missing tests on new branches, inconsistent error/response handling), Optional (docs). Flag over-engineering (one-call-site abstractions, speculative generality). Quote file:line. End with APPROVE or REQUEST CHANGES. You are READ-ONLY — never modify files.",
  tools: ["Read", "Grep", "Glob", "Bash"],
  model: "sonnet",
  effort: "medium",
})

/** All subagents, in a stable order. Declared on `manifest.subagents`. */
export const REFACTOR_SUBAGENTS: PluginSubagentDef[] = [GO_ANALYZER, DIFF_REVIEWER]
