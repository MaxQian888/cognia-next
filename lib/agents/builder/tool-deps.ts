/**
 * The host side of the Agent Builder's tools (ADR-0220): where the catalogs
 * come from and how a patch is written. Resolved lazily by the plugin-tool
 * IPC dispatcher, like every built-in family's deps.
 */

import type { AgentBuilderToolDeps } from "@/lib/claude/agent-builder-builtin-tools"
import { getDb } from "@/lib/db/schema"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listKnowledgeBases } from "@/lib/db/knowledge-bases"
import { listSkillEntries } from "@/lib/plugin/registries/skill-registry"
import { selectPluginSkills } from "@/hooks/skills/use-plugin-skills"
import { modelPresetOptions } from "@/lib/claude/model-presets"
import { applyDraftPatch, type DraftPatchResult } from "./draft-ops"
import { createAgentFromBuilder, writeBuilderDraft } from "./builder-session"

export function resolveAgentBuilderToolDeps(): AgentBuilderToolDeps {
  return {
    getSession: (id) => getDb().sessions.get(id),
    catalogs: async () => {
      const [skills, mcpServers, knowledgeBases] = await Promise.all([
        listSkills(),
        listMcpServers(),
        listKnowledgeBases(),
      ])
      return {
        skills: skills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
        pluginSkills: selectPluginSkills(listSkillEntries(), "character"),
        mcpServers: mcpServers.map((m) => ({
          id: m.id,
          name: m.name,
          enabled: m.enabled,
          transport: m.transport,
        })),
        knowledgeBases: knowledgeBases.map((kb) => ({
          id: kb.id,
          name: kb.name,
          description: kb.description,
        })),
      }
    },
    models: modelPresetOptions,
    writeDraft: async (sessionId, patch, catalogs) => {
      let outcome: DraftPatchResult | undefined
      const state = await writeBuilderDraft(
        sessionId,
        (draft) => {
          outcome = applyDraftPatch(draft, patch, catalogs)
          return outcome.draft
        },
        "agent"
      )
      return { state, changed: outcome?.changed ?? [], rejected: outcome?.rejected ?? [] }
    },
    createAgent: createAgentFromBuilder,
  }
}
