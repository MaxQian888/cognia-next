/**
 * `issue.list_projects` — the delivery containers of the active workspace, so
 * the assistant can resolve "the Mercury project" → an `issueProjectId`
 * before calling `issue_create`. Read-only.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"

const schema = z.object({
  query: z.string().optional().describe("Optional case-insensitive filter on name or key."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.list_projects",
  family: "issue",
  label: { en: "List issue projects", "zh-CN": "列出议题项目" },
  description: {
    en: "List the issue projects (delivery containers) of the active workspace with their ids, keys and status. Use it to resolve a project name the user mentioned to the id `issue_create` needs.",
    "zh-CN":
      "列出当前工作区的议题项目（交付容器）及其 id、key 与状态，用于把用户提到的项目名解析成 issue_create 需要的 id。",
  },
  platforms: "any",
  mutation: "read",
  imAccess: "always",
  mcpToolName: "issue_list_projects",
  inputSchema: schema,
  execute: async (args) => {
    const { useProjectStore } = await import("@/stores/project/project-store")
    const { ensureDefaultProject } = await import("@/lib/db/project-scope")
    const { listIssueProjects } = await import("@/lib/db/issue-projects")
    const workspaceId =
      useProjectStore.getState().activeProjectId ?? (await ensureDefaultProject()).id
    const needle = args.query?.trim().toLowerCase()
    const projects = (await listIssueProjects({ projectId: workspaceId }))
      .filter(
        (p) =>
          !needle || p.name.toLowerCase().includes(needle) || p.key.toLowerCase().includes(needle)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return {
      workspaceId,
      projects: projects.map((p) => ({ id: p.id, key: p.key, name: p.name, status: p.status })),
    }
  },
}

registerBuiltInSkill(skill)
