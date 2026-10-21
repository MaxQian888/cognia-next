/**
 * Plugin `ctx.agentConfig` API (ADR-0238).
 *
 * The agent configuration a governance plugin audits — instruction files,
 * markdown agent files, Skills, characters, templates, modes, presets,
 * workspace instructions and prompt overrides — read through the Prompt
 * Center's owners (`lib/agent-config/`), never through raw files.
 *
 * Rules this module holds, each pinned by its test:
 *
 *  - **Reads never carry a secret.** Hooks, MCP servers and permission rules
 *    are only reachable as `readFacts`, a structural summary the host builds;
 *    there is no method that returns a settings file, a hook command line or a
 *    server configuration.
 *  - **Text bound for a model is redacted by the host.** `redactForModel`
 *    keeps line numbers so a finding still points at the right line, and says
 *    `null` when the text cannot be made safe to send.
 *  - **Every write is the user's.** `applyEdit` asks the consent broker for
 *    each change, scoped to the surface, and then writes through the owner
 *    with the version that was read, so a change made since is a conflict.
 *  - **Gated** by `agent-config:read` (every read) and `agent-config:write`
 *    (`applyEdit`).
 */

import { applyAgentConfigEdit } from "@/lib/agent-config/apply"
import { readAgentConfigFacts } from "@/lib/agent-config/facts"
import { readAgentConfigProvenance } from "@/lib/agent-config/provenance"
import { redactForModel } from "@/lib/agent-config/redact"
import { checkAgentConfigReferences } from "@/lib/agent-config/references"
import { listAgentConfigSurfaces, readAgentConfigSurface } from "@/lib/agent-config/surfaces"
import type {
  AgentConfigApplyResult,
  AgentConfigEdit,
  AgentConfigFacts,
  AgentConfigLineProvenance,
  AgentConfigReferenceCheck,
  AgentConfigReferenceInput,
  AgentConfigSurfaceDocument,
  AgentConfigSurfaceListing,
} from "@/lib/agent-config/types"
import { createPluginSystemLogger } from "@/lib/plugin/core/logger"
import { getPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"

export type {
  AgentConfigApplyResult as PluginAgentConfigApplyResult,
  AgentConfigEdit as PluginAgentConfigEdit,
  AgentConfigFacts as PluginAgentConfigFacts,
  AgentConfigHookFact as PluginAgentConfigHookFact,
  AgentConfigLineProvenance as PluginAgentConfigLineProvenance,
  AgentConfigMcpServerFact as PluginAgentConfigMcpServerFact,
  AgentConfigPathStatus as PluginAgentConfigPathStatus,
  AgentConfigPermissionFact as PluginAgentConfigPermissionFact,
  AgentConfigReferenceCheck as PluginAgentConfigReferenceCheck,
  AgentConfigReferenceInput as PluginAgentConfigReferenceInput,
  AgentConfigSkillFacts as PluginAgentConfigSkillFacts,
  AgentConfigSurface as PluginAgentConfigSurface,
  AgentConfigSurfaceDocument as PluginAgentConfigSurfaceDocument,
  AgentConfigSurfaceListing as PluginAgentConfigSurfaceListing,
  AgentConfigSurfaceSource as PluginAgentConfigSurfaceSource,
} from "@/lib/agent-config/types"

export interface PluginAgentConfigScope {
  /** The workspace to read; omit for the active one, `null` for account-only. */
  workspaceId?: string | null
}

/** Longest summary the consent prompt shows. */
export const AGENT_CONFIG_SUMMARY_MAX = 280

export interface PluginAgentConfigAPI {
  /** Every surface an agent loads, in the Prompt Center's order, with load order for files. */
  listSurfaces(options?: PluginAgentConfigScope): Promise<AgentConfigSurfaceListing>
  /** One surface's text and the version a later edit is checked against; `null` when it is gone. */
  readSurface(
    key: string,
    options?: PluginAgentConfigScope
  ): Promise<AgentConfigSurfaceDocument | null>
  /** Structural facts about hooks, permission rules, MCP servers, Skills and the default model. */
  readFacts(options?: PluginAgentConfigScope): Promise<AgentConfigFacts>
  /** Whether paths and package scripts an instruction names still exist in the workspace. */
  checkReferences(input: AgentConfigReferenceInput): Promise<AgentConfigReferenceCheck>
  /** Commit and time per line of a file-backed surface; `null` outside a repository. */
  readProvenance(key: string): Promise<AgentConfigLineProvenance[] | null>
  /** `text` made safe for a model, line count unchanged; `null` when it cannot be. */
  redactForModel(text: string): string | null
  /** Write a change through the surface's owner after the user confirms it. */
  applyEdit(edit: AgentConfigEdit): Promise<AgentConfigApplyResult>
}

export class AgentConfigConsentDeniedError extends Error {
  readonly code = "agent_config_consent_denied"
  constructor(readonly key: string) {
    super(`the change to ${key} was not approved`)
    this.name = "AgentConfigConsentDeniedError"
  }
}

function assertKey(method: string, key: unknown): asserts key is string {
  if (typeof key !== "string" || !key.includes(":")) {
    throw new TypeError(`[agent-config-api] ${method}() takes a surface key`)
  }
}

export interface AgentConfigAPIDeps {
  requestConsent?: (input: { pluginId: string; key: string; reason: string }) => Promise<boolean>
}

async function defaultConsent(input: { pluginId: string; key: string; reason: string }) {
  return getPluginConsentBroker().request({
    pluginId: input.pluginId,
    permission: "agent-config:write",
    // One decision per surface: "always allow this session" for one file never
    // approves writes to another.
    scope: `agent-config-write:${input.key}`,
    reason: input.reason,
  })
}

export function createAgentConfigAPI(
  pluginId: string,
  deps: AgentConfigAPIDeps = {}
): PluginAgentConfigAPI {
  const logger = createPluginSystemLogger(pluginId)
  const requestConsent = deps.requestConsent ?? defaultConsent
  const api: PluginAgentConfigAPI = {
    listSurfaces: (options = {}) => listAgentConfigSurfaces(options.workspaceId),
    async readSurface(key, options = {}) {
      assertKey("readSurface", key)
      return (await readAgentConfigSurface(key, options.workspaceId)) ?? null
    },
    readFacts: (options = {}) => readAgentConfigFacts(options.workspaceId),
    checkReferences: (input) => checkAgentConfigReferences(input ?? {}),
    async readProvenance(key) {
      assertKey("readProvenance", key)
      return readAgentConfigProvenance(key)
    },
    redactForModel(text) {
      if (typeof text !== "string")
        throw new TypeError("[agent-config-api] redactForModel() takes text")
      return redactForModel(text)
    },
    async applyEdit(edit) {
      if (!edit || typeof edit.text !== "string") {
        throw new TypeError("[agent-config-api] applyEdit() takes { key, text, version, summary }")
      }
      assertKey("applyEdit", edit.key)
      const summary = String(edit.summary ?? "")
        .trim()
        .slice(0, AGENT_CONFIG_SUMMARY_MAX)
      if (!summary)
        throw new TypeError("[agent-config-api] applyEdit() needs a summary to show the user")
      // The host names the target itself; the plugin's summary says why.
      const reason = `${summary}\n${edit.key}`
      const approved = await requestConsent({ pluginId, key: edit.key, reason })
      if (!approved) throw new AgentConfigConsentDeniedError(edit.key)
      const result = await applyAgentConfigEdit({ ...edit, summary })
      logger.info(`[agent-config] applied a change to ${edit.key}`)
      return result
    },
  }
  return createGuardedAPI(
    pluginId,
    api,
    {
      listSurfaces: "agent-config:read",
      readSurface: "agent-config:read",
      readFacts: "agent-config:read",
      checkReferences: "agent-config:read",
      readProvenance: "agent-config:read",
      applyEdit: ["agent-config:read", "agent-config:write"],
    },
    // A pure host helper over text the plugin already holds.
    { unguarded: ["redactForModel"] }
  )
}
