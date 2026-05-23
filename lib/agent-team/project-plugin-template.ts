/**
 * Project a plugin-contributed `PluginAgentTeamTemplateDef` into the host
 * `AgentTeamTemplate` shape so plugin templates render alongside built-ins in
 * every picker (settings section + list page + create dialog). Carries the
 * extended teammate fields (systemPrompt / capabilities / governanceHints /
 * tags / iconKey) added in ADR-0032 so the apply flow can honor them.
 *
 * Runtime template id is namespaced `<pluginId>:<id>` to avoid colliding with
 * built-in / user template ids.
 */

import type { AgentTeamTemplate } from "@/types/agent/agent-team"
import type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"

export interface PluginTemplateOverlayEntry {
  id: string
  entry: PluginAgentTeamTemplateDef
  pluginId?: string
}

export function projectPluginTemplate(entry: PluginTemplateOverlayEntry): AgentTeamTemplate {
  return {
    id: entry.pluginId ? `${entry.pluginId}:${entry.id}` : entry.id,
    name: entry.entry.name,
    description: entry.entry.description,
    category: entry.entry.category,
    teammates: entry.entry.teammates.map((tm) => ({
      name: tm.name,
      description: tm.description,
      specialization: tm.specialization,
      config: tm.config,
      systemPrompt: tm.systemPrompt,
      capabilities: tm.capabilities,
      governanceHints: tm.governanceHints,
      tags: tm.tags,
      iconKey: tm.iconKey,
    })),
    taskTemplates: entry.entry.taskTemplates,
    config: entry.entry.config,
    icon: entry.entry.icon,
    isBuiltIn: false,
  }
}
