/**
 * The {@link GovernanceHost} the runtime runs on, built from the plugin
 * context. The only module besides `index.tsx` that touches `ctx`.
 */
import type { PluginContext } from "@cognia/plugin-sdk"

import { readGovernanceConfig } from "./config"
import type { GovernanceHost, WorkspaceInfo } from "./runtime/runtime"

function rootPaths(project: {
  roots?: Array<{ path: string; isPrimary?: boolean }>
  rootDir?: string
}): string[] {
  const roots = project.roots ?? []
  if (roots.length === 0) return project.rootDir ? [project.rootDir] : []
  // The primary root first: it is the working directory an eval run loads instructions from.
  return [...roots]
    .sort((a, b) => Number(Boolean(b.isPrimary)) - Number(Boolean(a.isPrimary)))
    .map((root) => root.path)
}

export function createGovernanceHost(ctx: PluginContext): GovernanceHost {
  return {
    agentConfig: ctx.agentConfig,
    storage: ctx.storage,
    ai: {
      chat: (messages, options) => ctx.ai.chat(messages, options),
      getDefaultModel: () => ctx.ai.getDefaultModel(),
    },
    sessions: {
      listSessions: (filter) => ctx.session.listSessions(filter),
      getMessages: (sessionId, options) => ctx.session.getMessages(sessionId, options),
      getSession: (id) => ctx.session.getSession(id),
    },
    async listWorkspaces(): Promise<WorkspaceInfo[]> {
      const projects = await ctx.project.listProjects()
      return projects.map((project) => ({
        id: project.id,
        name: project.name,
        roots: rootPaths(project),
      }))
    },
    currentWorkspaceId: () => ctx.project.getCurrentProjectId(),
    async resolvePrompt(id, values) {
      return (await ctx.prompts.resolve(id, values ? { values } : {})).text
    },
    runEval: (args) => ctx.eval.runDataset({ targetKind: "chat", ...args }),
    async listEvalDatasets() {
      const datasets = await ctx.eval.listDatasets()
      return datasets.map((dataset) => ({ id: dataset.id, name: dataset.name }))
    },
    config: () => readGovernanceConfig(ctx.configuration),
    notify: (title, body) => ctx.ui.showNotification({ title, body, type: "info" }),
    navigate: (href) => ctx.ui.navigate(href),
    t: (key, params) => ctx.i18n.t(key, params),
    now: () => Date.now(),
    newId: () => crypto.randomUUID(),
    log: (message, error) => ctx.logger.warn(`[config-governance] ${message}`, error),
  }
}
