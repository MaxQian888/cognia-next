/**
 * Mirror a squad template into the unified template platform as it is written.
 *
 * The two systems already meet: `migrateLegacyTemplates` projects every
 * non-built-in squad template into the `agentTeam` domain through
 * `projectLegacyAgentTeam`, and Discover reads the result. But it runs once, at
 * boot. So a template you saved was invisible to the platform, and to Discover,
 * to global search and to fork/export, until the next restart.
 *
 * This is step one of the convergence, and deliberately only step one. The
 * platform becomes the place a squad template is written to. The legacy store
 * and its registry stay exactly as they are on the read side, because the
 * settings gallery is not just a list. It does CRUD against the store, projects
 * plugin templates, renders dependency warnings, and the same registry still
 * serves `ctx.team.instantiateTemplate` for plugins. Swapping its data source
 * in one move would leave edit, delete, plugin-unload and the plugin API
 * disagreeing about what exists.
 *
 * Failure is not fatal. The mirror is an additional home for the template, not
 * its only one, and the boot-time migration will pick up anything missed.
 */

import { loggers } from "@cognia/logging"

import { projectLegacyAgentTeam } from "@/lib/templates/legacy-sources"
import { getTemplateRuntime } from "@/lib/templates/runtime"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

// The agent channel, not the shell one: this is squad-template code, and it
// runs from the squad surfaces that already log there.
const log = loggers.agent

/** Stable, so re-saving the same template updates rather than duplicating. */
export function platformIdForSquadTemplate(template: AgentTeamTemplate): string {
  return `legacy.agentTeam.${template.id}`
}

export async function publishSquadTemplateToPlatform(
  template: AgentTeamTemplate,
  runtime = getTemplateRuntime()
): Promise<void> {
  // A built-in is already projected by `refreshBuiltInTemplateOverlays` on
  // every boot, and it is not the user's to re-publish.
  if (template.isBuiltIn) return
  try {
    const projected = projectLegacyAgentTeam(template)
    const id = platformIdForSquadTemplate(template)
    const existing = await runtime.repository.getDraft(id)
    if (existing) {
      await runtime.service.saveDraft(
        { ...existing, ...projected, id, payload: projected.payload },
        existing.revision
      )
      return
    }
    await runtime.service.createDraft({ ...projected, id })
  } catch (error) {
    log.warn("squad template platform mirror failed", {
      templateId: template.id,
      err: String(error),
    })
  }
}
