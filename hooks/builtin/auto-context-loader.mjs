// Built-in hook: auto-load project context for an agent session.
//
// Fires on SessionStart / UserPromptSubmit. If the working directory holds a
// `.cognia/agent-context.md` file, its contents are surfaced as
// `additionalContext` so the agent starts every turn with the project's
// standing instructions — without the user pasting them each time.
//
// Self-contained (no `lib/` imports) so it runs as a spawned command hook in
// both the desktop (Rust) and CLI runtimes. Exit 0 always; emitting context is
// best-effort and never blocks.
import { readFileSync } from "node:fs"
import path from "node:path"

let input
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  process.exit(0)
}

const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd()
const event = input.hook_event_name ?? "SessionStart"

let context = ""
try {
  context = readFileSync(path.join(cwd, ".cognia", "agent-context.md"), "utf8").trim()
} catch {
  process.exit(0) // no context file ⇒ nothing to add
}
if (!context) process.exit(0)

// Cap so a runaway context file can't blow the prompt budget.
const MAX = 8000
const clipped = context.length > MAX ? `${context.slice(0, MAX)}\n…(truncated)` : context

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: `Project context (.cognia/agent-context.md):\n${clipped}`,
    },
  })
)
