/**
 * Which directory a Bot run works in.
 *
 * The Bot plane had a `resolveCwd` option and nobody to supply it, so
 * `executors/agent-turn.ts` refused every run it was handed. That refusal is
 * correct for a genuinely rootless Bot and was firing for all of them.
 *
 * This resolves through `lib/workspace/effective-cwd.ts`, the same precedence
 * chain `resolveSendOptions` uses, minus the two inputs that only a chat
 * session has. What is left is exactly what an installation can answer:
 *
 *   installation scope's workspace root -> character default -> app default
 *
 * Reading Dexie rather than the stores is deliberate. The brain has no zustand,
 * and `hooks/chat/use-effective-cwd.ts` and `lib/plugin/api/workspace-root.ts`
 * both answer "what is OPEN", which is a different question from "what does
 * this installation own".
 */

import { getBotInstallation } from "@/lib/db/bot-installations"
import { resolveCharacterById } from "@/lib/db/characters"
import { getDb } from "@/lib/db/schema"
import { getSettings } from "@/lib/db/settings"
import { resolveInstalledBot } from "@/lib/bot/installed-bot"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"

/**
 * The workspace an installation is scoped to, if any.
 *
 * `projectId` first: a project-scoped installation names the narrower of the
 * two, and `workspaceId` is denormalized onto the row alongside it.
 */
async function scopedProject(input: { projectId?: string; workspaceId?: string }) {
  const id = input.projectId ?? input.workspaceId
  if (!id) return null
  return (await getDb().projects.get(id)) ?? null
}

/**
 * Resolve the working directory for one installation, or `undefined` when it
 * genuinely has none.
 *
 * Every read is best-effort: a Bot whose character was deleted, or whose
 * workspace row is gone, still resolves down the chain to the app default
 * rather than failing the run before it starts.
 */
export async function resolveBotInstallationCwd(
  installationId: string
): Promise<string | undefined> {
  const installation = await getBotInstallation(installationId)
  if (!installation) return undefined

  const [activeProject, characterWorkingDir, defaultWorkingDir] = await Promise.all([
    scopedProject(installation).catch(() => null),
    resolveCharacterWorkingDir(installationId).catch(() => undefined),
    getSettings()
      .then((settings) => settings.defaultWorkingDir)
      .catch(() => undefined),
  ])

  return resolveEffectiveCwd({
    activeProject,
    ...(characterWorkingDir ? { characterWorkingDir } : {}),
    ...(defaultWorkingDir ? { defaultWorkingDir } : {}),
  })
}

/**
 * The persona's own default directory.
 *
 * Resolved through the installation's definition rather than the row, because
 * `character` lives on the definition and a plugin one is a registry overlay
 * with no row of its own.
 */
async function resolveCharacterWorkingDir(installationId: string): Promise<string | undefined> {
  const installation = await getBotInstallation(installationId)
  if (!installation) return undefined
  const resolved = await resolveInstalledBot(installation)
  const characterId = resolved?.definition.character
  if (!characterId) return undefined
  const character = await resolveCharacterById(characterId)
  return character?.workingDir ?? undefined
}
