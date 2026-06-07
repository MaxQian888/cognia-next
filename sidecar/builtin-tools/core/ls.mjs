// Core `ls` tool — directory listing with optional ignore globs.

import path from "node:path"
import fsp from "node:fs/promises"
import { z } from "zod"
import { tool } from "@anthropic-ai/claude-agent-sdk"

import { toolError, toolText } from "../safety.mjs"
import { resolveToolPath } from "./read.mjs"

export const MAX_ENTRIES = 500

export const lsShape = {
  path: z
    .string()
    .optional()
    .describe(
      "Directory to list (absolute, or relative to the session working directory). Defaults to the working directory."
    ),
  ignore: z
    .array(z.string())
    .optional()
    .describe('Glob patterns of entry names to exclude (e.g. ["*.log", "node_modules"]).'),
}

/** Convert a simple glob (\*, ?) to a RegExp matching the WHOLE name. */
export function nameGlobToRegExp(glob) {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

export function createLsTool({ cwd }) {
  async function execLs(args) {
    try {
      const abs = resolveToolPath(cwd, args.path ?? ".")
      let entries
      try {
        entries = await fsp.readdir(abs, { withFileTypes: true })
      } catch (err) {
        return toolError(`cannot list ${abs}: ${err.message}`)
      }
      const ignoreRes = (args.ignore ?? []).map(nameGlobToRegExp)
      const kept = entries.filter((e) => !ignoreRes.some((re) => re.test(e.name)))
      kept.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name < b.name ? -1 : 1
      })
      const shown = kept.slice(0, MAX_ENTRIES)
      const lines = shown.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      const note =
        kept.length > MAX_ENTRIES ? `\n… ${kept.length - MAX_ENTRIES} more entries not shown` : ""
      return toolText(`${abs}\n${lines.join("\n")}${note}`)
    } catch (err) {
      return toolError(err, "ls")
    }
  }

  return tool(
    "ls",
    "List the entries of a directory (directories first, marked with a trailing slash). Read-only.",
    lsShape,
    execLs,
    { alwaysLoad: true }
  )
}
