/**
 * Plugin SDK — `agent-team-template` capability surface (ADR-0032).
 *
 * Re-exports the `defineAgentTeamTemplate()` authoring helper and the
 * dynamic registry plugins use to contribute complete agent-team blueprints
 * (roster + tasks + config + requires) surfaced in the team picker.
 *
 * Sources:
 *  - `packages/plugin-sdk/src/define/define-agent-team-template.ts`
 *  - `lib/plugin/registries/agent-team-template-registry.ts`
 *  - `types/plugin/plugin-agent-team-template.ts`
 *
 * Authors call `defineAgentTeamTemplate()` for compile-time shape checks,
 * then declare the template in the manifest's `agentTeamTemplates` array or
 * register it dynamically from `activate(ctx)`. `validateTemplateRequires`
 * surfaces missing capability dependencies before the template is offered.
 */

export { defineAgentTeamTemplate } from "../define/define-agent-team-template"

export {
  registerAgentTeamTemplate,
  unregisterAgentTeamTemplateById,
  unregisterAgentTeamTemplatesByPlugin,
  getAgentTeamTemplate,
  getAgentTeamTemplateEntry,
  listAgentTeamTemplateIds,
  listAgentTeamTemplateEntries,
  validateTemplateRequires,
} from "@/lib/plugin/registries/agent-team-template-registry"

export type { PluginAgentTeamTemplateDef } from "@/types/plugin/plugin-agent-team-template"
