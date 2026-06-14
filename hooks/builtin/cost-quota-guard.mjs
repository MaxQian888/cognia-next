// Built-in hook: deny a turn once a session's token spend crosses a budget.
//
// Fires on UserPromptSubmit. The budget comes from (first found):
//   1. env `COGNIA_TOKEN_BUDGET` (integer tokens), or
//   2. `${cwd}/.cognia/hook-budget.json` → { "maxTokensPerSession": <int> }.
// The already-spent count is read from the hook payload's `tokensUsed` (the
// runtime threads it through for goal/loop turns); absent ⇒ treated as 0.
//
// Blocks by exiting 2 with a reason on stderr — the contract honoured by BOTH
// the Rust command handler (exit 2 ⇒ block, stderr line = reason) and the CLI
// runner (non-zero exit on a blocking event ⇒ deny). A budget that is absent or
// unparseable soft-allows (exit 0): a misconfigured guard must never lock a user
// out of their own agent.
import { readFileSync } from "node:fs"
import path from "node:path"

let input
try {
  input = JSON.parse(readFileSync(0, "utf8"))
} catch {
  process.exit(0)
}

const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd()

function resolveBudget() {
  const fromEnv = Number.parseInt(process.env.COGNIA_TOKEN_BUDGET ?? "", 10)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  try {
    const cfg = JSON.parse(readFileSync(path.join(cwd, ".cognia", "hook-budget.json"), "utf8"))
    const n = Number(cfg?.maxTokensPerSession)
    if (Number.isInteger(n) && n > 0) return n
  } catch {
    // no config ⇒ no budget
  }
  return null
}

const budget = resolveBudget()
if (budget == null) process.exit(0) // unconfigured ⇒ soft-allow

const spent = Number(input.tokensUsed)
const used = Number.isFinite(spent) && spent > 0 ? spent : 0

if (used >= budget) {
  process.stderr.write(
    `Token budget reached: ${used} ≥ ${budget} tokens this session. ` +
      `Raise COGNIA_TOKEN_BUDGET or .cognia/hook-budget.json, or start a new session.\n`
  )
  process.exit(2)
}
process.exit(0)
