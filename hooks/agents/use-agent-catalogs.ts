"use client"

/**
 * The catalogs an agent's profile points into (ADR-0220): skills, MCP servers
 * and knowledge bases, live. The editor needs them as option lists and the
 * capabilities tab needs them to turn stored ids back into names.
 */

import { useLiveQuery } from "dexie-react-hooks"
import type { McpServer, Skill } from "@cognia/agent-config-types"
import type { KnowledgeBase } from "@/types/knowledge-base"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listKnowledgeBases } from "@/lib/db/knowledge-bases"

export interface AgentCatalogs {
  skills: Skill[]
  mcpServers: McpServer[]
  knowledgeBases: KnowledgeBase[]
}

const EMPTY_SKILLS: Skill[] = []
const EMPTY_MCP: McpServer[] = []
const EMPTY_KB: KnowledgeBase[] = []

export function useAgentCatalogs(): AgentCatalogs {
  const skills = useLiveQuery(() => listSkills(), []) ?? EMPTY_SKILLS
  const mcpServers = useLiveQuery(() => listMcpServers(), []) ?? EMPTY_MCP
  const knowledgeBases = useLiveQuery(() => listKnowledgeBases(), []) ?? EMPTY_KB
  return { skills, mcpServers, knowledgeBases }
}
