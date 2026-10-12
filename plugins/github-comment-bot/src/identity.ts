/**
 * Who this Bot is on GitHub, and what addresses it.
 *
 * The identity comes from the binding's `/user` read: on an App account the
 * host answers with the App's bot user (`<slug>[bot]`), on a token account
 * with the token's own user. Comments by that id are this Bot's output and
 * never commands. The default trigger exists only for an App, whose slug is
 * its own name; a token account's login is a person's, so it must be set.
 */

import type { BotRunContextV1, PluginContext } from "@cognia/plugin-sdk"
import { githubReader, type GithubReader } from "@cognia/github-bot-kit"

import { SetupError, TRIGGER_REQUIRED_MESSAGE, type Config } from "./config"

/** The integration slot every GitHub read and write of this Bot binds to. */
export const GITHUB_SLOT = "github"

export interface BotIdentity {
  id: number
  login: string
  isApp: boolean
}

export function readerFor(
  ctx: PluginContext,
  run: BotRunContextV1,
  config: Config,
  now: () => number = Date.now
): GithubReader {
  return githubReader(ctx, { runId: run.runId, slotId: GITHUB_SLOT }, config.repository, now)
}

export async function readIdentity(reader: GithubReader): Promise<BotIdentity> {
  const viewer = await reader.viewer()
  if (!Number.isSafeInteger(viewer?.id) || viewer.id < 1 || typeof viewer.login !== "string")
    throw new Error("The bound GitHub account did not report its identity")
  return { id: viewer.id, login: viewer.login, isApp: viewer.login.endsWith("[bot]") }
}

export function resolveTrigger(config: Config, identity: BotIdentity): string {
  if (config.trigger) return config.trigger
  if (identity.isApp) return `@${identity.login.replace(/\[bot\]$/, "")}`
  throw new SetupError("trigger_required", TRIGGER_REQUIRED_MESSAGE)
}
