/** Build-only adapter that forwards packaged MCP sidecar operations to the host. */
import { proxyToHost } from "@/lib/external-bridge/orchestration-proxy-client"

function hostCall(command: string, ...args: unknown[]): Promise<unknown> {
  return proxyToHost(command, { arguments: args })
}

export const wikiSearch = (...args: unknown[]) => hostCall("wikiSearch", ...args)
export const wikiRead = (...args: unknown[]) => hostCall("wikiRead", ...args)
export const ragSearch = (...args: unknown[]) => hostCall("ragSearch", ...args)
export const runtimeQuery = (...args: unknown[]) => hostCall("runtimeQuery", ...args)
export const agentDispatch = (...args: unknown[]) => hostCall("agentDispatch", ...args)
export const teamRun = (...args: unknown[]) => hostCall("teamRun", ...args)
export const teamList = (...args: unknown[]) => hostCall("teamList", ...args)
export const planList = (...args: unknown[]) => hostCall("planList", ...args)
export const planRun = (...args: unknown[]) => hostCall("planRun", ...args)
export const pluginToolInvoke = (...args: unknown[]) => hostCall("pluginToolInvoke", ...args)

export const connectorsListAdapters = (...args: unknown[]) =>
  hostCall("connectorsListAdapters", ...args)
export const connectorsListConversations = (...args: unknown[]) =>
  hostCall("connectorsListConversations", ...args)
export const connectorsGetAudit = (...args: unknown[]) => hostCall("connectorsGetAudit", ...args)
export const connectorsExportAudit = (...args: unknown[]) =>
  hostCall("connectorsExportAudit", ...args)
export const connectorsListDrafts = (...args: unknown[]) =>
  hostCall("connectorsListDrafts", ...args)
export const connectorsSendMessage = (...args: unknown[]) =>
  hostCall("connectorsSendMessage", ...args)

export const recordLesson = (...args: unknown[]) => hostCall("recordLesson", ...args)
export const saveSkillDraft = (...args: unknown[]) => hostCall("saveSkillDraft", ...args)
export const ingestNote = (...args: unknown[]) => hostCall("ingestNote", ...args)
export const memorySearch = (...args: unknown[]) => hostCall("memorySearch", ...args)
export const memoryList = (...args: unknown[]) => hostCall("memoryList", ...args)
export const memoryStore = (...args: unknown[]) => hostCall("memoryStore", ...args)
export const memoryUpdate = (...args: unknown[]) => hostCall("memoryUpdate", ...args)
export const memoryForget = (...args: unknown[]) => hostCall("memoryForget", ...args)

/** Sidecar projection of the host-owned immutable workflow service. */
export const proxiedWorkflowMcpHost = {
  listDeployments: () => hostCall("workflowListDeployments"),
  createRun: (input: unknown) => hostCall("workflowRunCreate", input),
  getRun: (input: unknown) => hostCall("workflowRunGet", input),
  listEvents: (input: unknown) => hostCall("workflowEventsList", input),
  cancelRun: (input: unknown) => hostCall("workflowRunCancel", input),
}

export const listAllWikiArticles = (...args: unknown[]) =>
  hostCall("listAllWikiArticles", ...args)
export const bulkCreateWikiArticles = (...args: unknown[]) =>
  hostCall("bulkCreateWikiArticles", ...args)
export const deleteAllWikiArticlesForScope = (...args: unknown[]) =>
  hostCall("deleteAllWikiArticlesForScope", ...args)
export const deleteStaleWikiArticles = (...args: unknown[]) =>
  hostCall("deleteStaleWikiArticles", ...args)
export const listWikiArticlesByScope = (...args: unknown[]) =>
  hostCall("listWikiArticlesByScope", ...args)
export const getWikiArticleBySlug = (...args: unknown[]) =>
  hostCall("getWikiArticleBySlug", ...args)
export const listSkills = (...args: unknown[]) => hostCall("listSkills", ...args)
export const getSkill = (...args: unknown[]) => hostCall("getSkill", ...args)
export const createSkill = (...args: unknown[]) => hostCall("createSkill", ...args)
export const updateSkill = (...args: unknown[]) => hostCall("updateSkill", ...args)
export const deleteSkill = (...args: unknown[]) => hostCall("deleteSkill", ...args)
export const listSkillsByIds = (...args: unknown[]) => hostCall("listSkillsByIds", ...args)
export const listEnabledSkillsByIds = (...args: unknown[]) =>
  hostCall("listEnabledSkillsByIds", ...args)
export const resolveEffectiveSkills = (...args: unknown[]) =>
  hostCall("resolveEffectiveSkills", ...args)
export const activeEffectiveSkillIds = (...args: unknown[]) =>
  hostCall("activeEffectiveSkillIds", ...args)
export const recordSkillUsage = (...args: unknown[]) => hostCall("recordSkillUsage", ...args)
export const renderSkillsCatalog = (...args: unknown[]) =>
  hostCall("renderSkillsCatalog", ...args)
export const renderSkillsSection = (...args: unknown[]) =>
  hostCall("renderSkillsSection", ...args)
export const upsertSkillByCanonicalId = (...args: unknown[]) =>
  hostCall("upsertSkillByCanonicalId", ...args)
export const workflowSkillBody = (...args: unknown[]) => hostCall("workflowSkillBody", ...args)
export const listCharacters = (...args: unknown[]) => hostCall("listCharacters", ...args)
export const getCharacter = (...args: unknown[]) => hostCall("getCharacter", ...args)
export const createCharacter = (...args: unknown[]) => hostCall("createCharacter", ...args)
export const updateCharacter = (...args: unknown[]) => hostCall("updateCharacter", ...args)
export const deleteCharacter = (...args: unknown[]) => hostCall("deleteCharacter", ...args)
export const listCharactersByIds = (...args: unknown[]) =>
  hostCall("listCharactersByIds", ...args)
export const resolveCharacterById = (...args: unknown[]) =>
  hostCall("resolveCharacterById", ...args)
export const recordCall = (...args: unknown[]) => hostCall("recordCall", ...args)
