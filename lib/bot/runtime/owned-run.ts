import { getExecutionRun } from "@/lib/db/execution-runs"
import { getBotInstallation } from "@/lib/db/bot-installations"
import { resolveInstalledBot } from "@/lib/bot/installed-bot"

/** Shared owner check for APIs that consume a Bot run as authority. */
export async function requireOwnedBotRun(pluginId: string, runId: string) {
  const run = await getExecutionRun(runId)
  if (!run || run.kind !== "bot" || !run.sourceId || !["running", "waiting"].includes(run.status)) {
    throw new Error("Bot run is missing or no longer active")
  }
  const installation = await getBotInstallation(run.sourceId)
  if (
    !installation ||
    installation.syncedFromHost ||
    installation.status !== "enabled" ||
    installation.definitionSource !== "plugin" ||
    !installation.definitionId.startsWith(`${pluginId}:`)
  ) {
    throw new Error("Bot run does not belong to this plugin on this host")
  }
  const resolved = await resolveInstalledBot(installation)
  if (!resolved || !resolved.definition.handler) throw new Error("Bot handler is unavailable")
  return { run, installation, resolved }
}
