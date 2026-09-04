/**
 * `issue.create` — file an issue from chat (ADR-0132 slice ③).
 *
 * Two shapes, one rule ("不点不落库" — nothing is saved until the user picks):
 *
 *   - IM session, no explicit project → PROPOSE: push the confirmation card
 *     (`lib/issues/im/propose.ts`) with one button per candidate project and
 *     return `pending`. The write happens in the `issue_action` callback when
 *     the user taps a project.
 *   - IM session with an explicit `issueProjectId`, or a desktop session →
 *     the dispatcher's own HITL card (`hitlSurface`) is the confirmation, and
 *     `execute` files the issue directly once it is confirmed.
 *
 * `mutation: "write"` because the second shape writes. Requires `send.a2ui`
 * only for the card; text-only channels still get the desktop-style path.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { resolveIssueActor, resolveWorkspaceId } from "./_core"

const schema = z.object({
  title: z.string().min(1).max(200).describe("Short imperative title for the issue."),
  description: z
    .string()
    .max(4000)
    .optional()
    .describe("Optional longer description / acceptance notes."),
  issueProjectId: z
    .string()
    .optional()
    .describe(
      "Delivery container id. Omit when the user did not name a project — the user is then asked to pick one on a card. Resolve names → ids with issue_list_projects."
    ),
  sourceMessageId: z
    .string()
    .optional()
    .describe(
      "Platform message id this issue was quoted from, when the user replied to a message."
    ),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.create",
  family: "issue",
  label: { en: "Create issue", "zh-CN": "创建议题" },
  description: {
    en: "File an issue on the local issue board from the conversation. Without a project id the user is asked to pick a project on a card first; nothing is saved until they do. Returns the created issue's identifier, or `pending` while the card is out.",
    "zh-CN":
      "把对话中的内容记为本地议题看板上的议题。未指定项目时先向用户推送选择项目的卡片，用户点选前不落库。返回新建议题的编号，或卡片待确认时返回 pending。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_create",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    if (ctx.imBinding && !args.issueProjectId) {
      const { proposeIssueFromIm } = await import("@/lib/issues/im/propose")
      const result = await proposeIssueFromIm({
        adapterId: ctx.imBinding.adapterId,
        conversationKey: ctx.imBinding.conversationKey,
        workspaceId,
        title: args.title,
        ...(args.description ? { description: args.description } : {}),
        ...(args.sourceMessageId ? { sourceMessageId: args.sourceMessageId } : {}),
      })
      if (result.status === "proposed") {
        return {
          status: "pending",
          draftId: result.draftId,
          instruction:
            "A card asking the user to pick a project was sent. Do not file the issue yourself; tell the user to tap a project on the card.",
        }
      }
      return { status: result.status }
    }

    const { createIssue } = await import("@/lib/db/issues")
    const { listIssueProjects } = await import("@/lib/db/issue-projects")
    let issueProjectId = args.issueProjectId
    if (issueProjectId) {
      // The id arrives from a model, which may be repeating one it saw in a
      // different workspace. `resolveIssueProject` refuses those, and accepts
      // a key so "file it in MERC" works without a lookup round trip.
      const { resolveIssueProject } = await import("./_core")
      issueProjectId = (await resolveIssueProject(issueProjectId, workspaceId)).id
    } else {
      // Desktop with no project named: the newest container is the honest default.
      const projects = await listIssueProjects({ projectId: workspaceId })
      const newest = [...projects].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (!newest) return { status: "no-projects" }
      issueProjectId = newest.id
    }
    const issue = await createIssue({
      projectId: workspaceId,
      issueProjectId,
      title: args.title,
      ...(args.description ? { description: args.description } : {}),
      // The assistant is filing this, not the user. `createdBy` is the only
      // record of that, and it used to say a human did it whatever called in.
      createdBy: await resolveIssueActor(ctx),
      ...(ctx.imBinding
        ? {
            origin: {
              kind: "im" as const,
              conversationKey: ctx.imBinding.conversationKey,
              ...(args.sourceMessageId ? { messageId: args.sourceMessageId } : {}),
            },
          }
        : {}),
    })
    if (ctx.imBinding) {
      const { pushIssueCard } = await import("@/lib/issues/im/push")
      await pushIssueCard({
        adapterId: ctx.imBinding.adapterId,
        conversationKey: ctx.imBinding.conversationKey,
        issue,
      })
    }
    return { status: "created", issueId: issue.id, identifier: issue.identifier }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_create_${Date.now().toString(36)}`,
      title: "Create issue",
      summary: `File "${args.title}" as an issue${args.issueProjectId ? "" : " (you will pick the project next)"}.`,
      details: [
        ...(args.issueProjectId ? [{ label: "Project", value: args.issueProjectId }] : []),
        ...(args.description
          ? [{ label: "Description", value: args.description.slice(0, 200) }]
          : []),
      ],
    }),
}

registerBuiltInSkill(skill)
