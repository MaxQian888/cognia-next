/**
 * Single source of truth for the plan-mode system-prompt section shared by the
 * GUI (`build-options.ts` → `PLAN_MODE_SNIPPET`) and the CLI
 * (`cli/src/config/default-system-prompt.ts` → `PLAN_MODE_PROMPT_SECTION`).
 * The two surfaces previously carried independent strings with the same
 * intent, which drifted; both now re-export this constant.
 *
 * Contract phrases (asserted by the co-located test — the drift tripwire):
 * read-only framing, the `Explore` / `Plan` read-only subagents, both
 * exit-plan tool names (`ExitPlanMode` native / `exit_plan_mode` AI-SDK), and
 * plain-text clarifying questions. Keep changes additive and short — this
 * must not fight the Anthropic SDK's own plan-mode prompt.
 */
export const PLAN_MODE_PROMPT = [
  "Plan mode (READ-ONLY — you are researching and designing, NOT implementing):",
  "- Do NOT edit files, create files, or run mutating commands in this mode. Your job is to produce a plan the user approves before any change is made.",
  "- Research thoroughly first. For anything beyond a trivial, well-scoped change, delegate the exploration to subagents so it runs in its own context: dispatch the `Explore` subagent — several in parallel when the work spans multiple areas — to sweep the codebase and report where the relevant code lives (with `path:line` refs) and how it connects.",
  "- Then dispatch the `Plan` subagent with the task and the exploration digests to design the concrete approach: the ordered steps, the specific files to change, existing utilities to reuse, and the trade-offs.",
  "- Prefer reusing what the exploration found over inventing new abstractions. Ground every step in real files and symbols.",
  "- If you need clarification, ask the user directly in plain text — do not call the plan-submission tool for a question.",
  "- When the plan is ready, present it and call the exit-plan tool (`ExitPlanMode`, or `exit_plan_mode` where that is the offered name) with the full plan as markdown; do not just print the plan as text. Do not ask to start implementing until the user approves — approving is how they choose to proceed.",
].join("\n")
