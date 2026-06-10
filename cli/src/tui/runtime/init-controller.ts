/**
 * `/init` controller — scaffold a starter `AGENTS.md` in the working directory so
 * the built-in agent (desktop + CLI) loads project instructions via
 * `lib/claude/instructions`. Refuses to overwrite any existing instruction file
 * (AGENTS.md / AGENT.md / CLAUDE.md). All fs effects are injectable for tests.
 */
import fs from "node:fs"
import path from "node:path"

import { errorMessage } from "./shared"
import type { TuiAction } from "../state/types"

/** Instruction filenames the agent discovers, in precedence order. */
export const INSTRUCTION_FILENAMES = ["AGENTS.md", "AGENT.md", "CLAUDE.md"] as const

/** A minimal, fill-in-the-blanks AGENTS.md body. */
export function agentsTemplate(projectName: string): string {
  return [
    `# ${projectName}`,
    "",
    "## Project overview",
    "",
    "<!-- One paragraph: what this project is and its stack. -->",
    "",
    "## Conventions",
    "",
    "- <!-- coding standards, naming, formatting, file layout -->",
    "",
    "## Commands",
    "",
    "- Build:",
    "- Test:",
    "- Lint:",
    "",
    "## Notes for the agent",
    "",
    "- <!-- anything the agent should always keep in mind -->",
    "",
  ].join("\n")
}

export interface InitDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  exists?: (p: string) => boolean
  write?: (p: string, content: string) => void
}

export async function runInit(deps: InitDeps): Promise<void> {
  const exists = deps.exists ?? ((p) => fs.existsSync(p))
  const present = INSTRUCTION_FILENAMES.find((f) => exists(path.join(deps.cwd, f)))
  if (present) {
    deps.dispatch({
      type: "NOTICE",
      message: `${present} already exists — leaving it untouched. Edit it directly.`,
    })
    return
  }
  const target = path.join(deps.cwd, "AGENTS.md")
  const projectName = path.basename(deps.cwd) || "Project"
  const write = deps.write ?? ((p, c) => fs.writeFileSync(p, c, "utf8"))
  try {
    write(target, agentsTemplate(projectName))
  } catch (err) {
    deps.dispatch({ type: "NOTICE", message: `Could not write AGENTS.md: ${errorMessage(err)}` })
    return
  }
  deps.dispatch({
    type: "NOTICE",
    message: `Created ${target} — fill it in and the agent will load it next turn.`,
  })
}
