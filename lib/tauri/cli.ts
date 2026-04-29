"use client"

import { getMatches } from "@tauri-apps/plugin-cli"
import { isTauri } from "@/lib/tauri"

export interface ParsedCli {
  workspacePath: string | null
  newChat: boolean
}

/**
 * Read the parsed CLI args the app was launched with. The shape is shaped by
 * the `plugins.cli.args` config in `tauri.conf.json` — keep this helper in
 * sync with that schema.
 */
export async function getLaunchCli(): Promise<ParsedCli> {
  if (!isTauri()) return { workspacePath: null, newChat: false }
  try {
    const matches = await getMatches()
    const wsArg = matches.args["workspace"]?.value
    const newArg = matches.args["new-chat"]?.value
    return {
      workspacePath: typeof wsArg === "string" && wsArg.length > 0 ? wsArg : null,
      newChat: newArg === true,
    }
  } catch (err) {
    console.warn("getLaunchCli failed", err)
    return { workspacePath: null, newChat: false }
  }
}
