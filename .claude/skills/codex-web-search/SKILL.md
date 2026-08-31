---
name: codex-web-search
description: Delegate current, external web research to Codex CLI in an isolated read-only subagent. Use for recent facts, official documentation, release or product comparisons, and citation-backed online lookups; do not use for repository-only searches or tasks that should edit files.
argument-hint: <research question>
context: fork
agent: codex-web-researcher
background: false
allowed-tools: Bash(${CLAUDE_SKILL_DIR}/scripts/run-search.mjs *)
---

# Codex Web Search

Run the supplied runner exactly once for this research request:

$ARGUMENTS

The runner path is:

`${CLAUDE_SKILL_DIR}/scripts/run-search.mjs`

Return its stdout unchanged. Do not perform the research yourself, invoke
Claude Code recursively, or fall back to `codex mcp-server`. If the runner
fails, report the error without substituting your own research.
