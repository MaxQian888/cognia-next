import { BUILT_IN_TEAM_TEMPLATES } from "@/types/agent/agent-team"
import { BUILT_IN_SUBAGENT_TEMPLATES } from "@/types/agent/sub-agent"
import { MODE_TEMPLATES } from "@/stores/agent/custom-mode-store"
import { listCharacters } from "@/lib/db/characters"
import { listSkills } from "@/lib/db/skills"
import { listTemplateWorkflows } from "@/lib/db/workflows"
import type { FullDomainTemplatePorts } from "./adapters"
import { TemplateCatalog } from "./catalog"
import { createTemplateDefinition } from "./contracts"
import { createLegacyTemplateSources } from "./legacy-sources"

export async function refreshBuiltInTemplateOverlays(input: {
  catalog: TemplateCatalog
  ports: FullDomainTemplatePorts
}): Promise<number> {
  const sources = createLegacyTemplateSources({
    ports: input.ports,
    readers: {
      agentTeams: () => BUILT_IN_TEAM_TEMPLATES,
      subagents: () => BUILT_IN_SUBAGENT_TEMPLATES,
      customModes: () =>
        MODE_TEMPLATES.map((mode) => ({
          ...mode,
          type: "custom",
          isBuiltIn: true,
        })),
      workflows: async () =>
        (await listTemplateWorkflows()).filter((workflow) => workflow.isBuiltIn),
      characters: async () =>
        (await listCharacters()).filter(
          (character) => character.isBuiltIn || character.id.startsWith("cognia-pack:")
        ),
      skills: async () => (await listSkills()).filter((skill) => skill.isBuiltIn),
    },
  })
  const definitions = []
  for (const source of sources) {
    for (const row of await source.read()) {
      const draft = await source.convert(row)
      definitions.push(
        await createTemplateDefinition({
          ...draft,
          id: draft.id.replace(/^legacy\./, "builtin."),
          status: "published",
          revision: 1,
          version: "1.0.0",
          provenance: { source: "built-in", trust: "built-in" },
        })
      )
    }
  }
  input.catalog.replaceSource("built-in", definitions)
  return definitions.length
}
