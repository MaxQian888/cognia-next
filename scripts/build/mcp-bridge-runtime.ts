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

export const listAllWikiArticles = (...args: unknown[]) =>
  hostCall("listAllWikiArticles", ...args)
export const getWikiArticleBySlug = (...args: unknown[]) =>
  hostCall("getWikiArticleBySlug", ...args)
export const listSkills = (...args: unknown[]) => hostCall("listSkills", ...args)
export const getSkill = (...args: unknown[]) => hostCall("getSkill", ...args)
export const listCharacters = (...args: unknown[]) => hostCall("listCharacters", ...args)
export const getCharacter = (...args: unknown[]) => hostCall("getCharacter", ...args)
export const recordCall = (...args: unknown[]) => hostCall("recordCall", ...args)
