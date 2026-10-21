/**
 * The agent configuration read model (ADR-0238).
 *
 * Everything an agent loads as instructions — repository instruction files,
 * markdown agent files, Skills, characters, subagent and team templates, custom
 * modes, presets, workspace instructions, the default system prompt and the
 * shipped prompt slots — listed behind one shape so governance tooling can
 * audit it without learning every owner. It is a projection over the Prompt
 * Center's owners (ADR-0236) plus the agent files the Prompt Center does not
 * list; every text keeps its single authority and every write goes back
 * through that owner.
 *
 * Settings that can hold secrets (hooks, MCP servers, permission rules) are
 * never returned as text. {@link AgentConfigFacts} is a structural summary the
 * host builds from them, so neither a plugin nor a model ever reads a
 * credential, a header or a hook command line.
 */

export type {
  AgentConfigApplyResult,
  AgentConfigEdit,
  AgentConfigFacts,
  AgentConfigHookFact,
  AgentConfigLineProvenance,
  AgentConfigMcpServerFact,
  AgentConfigPathStatus,
  AgentConfigPermissionFact,
  AgentConfigReferenceCheck,
  AgentConfigReferenceInput,
  AgentConfigSkillFacts,
  AgentConfigSurface,
  AgentConfigSurfaceDocument,
  AgentConfigSurfaceListing,
  AgentConfigSurfaceSource,
} from "@cognia/plugin-contract/lib/agent-config/types"
