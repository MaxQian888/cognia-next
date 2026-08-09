/**
 * Interactive model selector for `cognia x <agent>`.
 *
 * Presents the user with a model picker, optionally fast-forwarding to a
 * remembered preference from a previous session. Uses a simple readline prompt
 * (no external dependencies beyond Node.js) since this runs before the agent
 * TUI takes over the terminal.
 */

import readline from "node:readline/promises"
import { stdin, stdout } from "node:process"

import type { SupportedAgent } from "./detect-cli"

/**
 * Pre-curated model lists per agent. These are the models commonly available
 * through the cognia gateway. The gateway's routing snapshot may expose more;
 * these are sensible defaults when the gateway is not yet running.
 */
const DEFAULT_MODELS: Record<SupportedAgent, string[]> = {
  claude: [
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-haiku-4-20250414",
    "claude-3.5-sonnet-20241022",
  ],
  codex: ["o3", "o4-mini", "gpt-4.1", "codex-mini-latest"],
}

/** Friendly labels shown in the picker. Falls back to the raw model id. */
const MODEL_LABELS: Record<string, string> = {
  "claude-sonnet-4-20250514": "Claude Sonnet 4 (recommended)",
  "claude-opus-4-20250514": "Claude Opus 4",
  "claude-haiku-4-20250414": "Claude Haiku 4",
  "claude-3.5-sonnet-20241022": "Claude 3.5 Sonnet",
  o3: "o3 (recommended)",
  "o4-mini": "o4-mini",
  "gpt-4.1": "GPT-4.1",
  "codex-mini-latest": "Codex Mini",
}

export interface ModelSelectorDeps {
  /** Injectable readline for testing. Returns `null` on EOF. */
  readLine?: (prompt: string) => Promise<string | null>
  /** Injectable model list (overrides the default catalog). */
  models?: string[]
  /** Whether stdin is a TTY. If false, auto-selects without prompting. */
  isTTY?: boolean
}

/**
 * Prompt the user to pick a model for the given agent.
 *
 * - If `remembered` is set, shows a 3-second auto-select that the user can
 *   override by pressing any key.
 * - Otherwise shows a numbered list for the user to pick from.
 *
 * @returns The selected model id string.
 */
export async function selectModel(
  agent: SupportedAgent,
  remembered?: string,
  deps: ModelSelectorDeps = {}
): Promise<string> {
  const models = deps.models ?? DEFAULT_MODELS[agent]

  // When readLine is injected (testing), always treat as interactive.
  // Otherwise, check the real TTY state — non-TTY auto-selects silently.
  const isTTY = deps.readLine ? true : (deps.isTTY ?? process.stdin.isTTY ?? false)

  // Non-interactive mode: auto-select without prompting (CI / piped input)
  if (!isTTY) {
    return remembered && models.includes(remembered) ? remembered : models[0]
  }

  const readLine = deps.readLine ?? createDefaultReadLine()

  // Fast path: remembered preference
  if (remembered && models.includes(remembered)) {
    const label = MODEL_LABELS[remembered] ?? remembered
    const answer = await readLine(
      `\x1b[36m?\x1b[0m Model: ${label} (Enter to confirm, or type number to change): `
    )
    if (answer === null || answer.trim() === "") {
      return remembered
    }
    // User typed something — fall through to the picker using their input
    const idx = parseInt(answer.trim(), 10)
    if (idx >= 1 && idx <= models.length) {
      return models[idx - 1]
    }
    // Treat raw input as a custom model id
    if (answer.trim().length > 0) return answer.trim()
    return remembered
  }

  // Full picker
  const header = `\n\x1b[1mSelect a model for ${agent}:\x1b[0m\n`
  const lines = models.map((m, i) => `  \x1b[33m${i + 1}\x1b[0m) ${MODEL_LABELS[m] ?? m}`)
  const footer = `\n  Or type a custom model id.\n`

  const prompt = [header, ...lines, footer].join("\n") + `\n\x1b[36m?\x1b[0m Choice [1]: `

  const answer = await readLine(prompt)
  if (answer === null || answer.trim() === "") {
    // Default to first model
    return models[0]
  }

  const idx = parseInt(answer.trim(), 10)
  if (idx >= 1 && idx <= models.length) {
    return models[idx - 1]
  }

  // Custom model id
  return answer.trim()
}

/** Get the default models list for an agent. Exported for testing/reuse. */
export function getDefaultModels(agent: SupportedAgent): string[] {
  return [...DEFAULT_MODELS[agent]]
}

/** Create a default readline-based input reader. */
function createDefaultReadLine(): (prompt: string) => Promise<string | null> {
  let rl: readline.Interface | undefined
  return async (prompt: string) => {
    rl ??= readline.createInterface({ input: stdin, output: stdout })
    try {
      return await rl.question(prompt)
    } catch {
      return null
    } finally {
      rl?.close()
      rl = undefined
    }
  }
}
