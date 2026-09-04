/**
 * `issue.comment`: append a comment to an issue's activity trail.
 *
 * Separate from `issue.update` because a comment is not a field edit: it is
 * append-only, it needs its own capability bit (`canComment`), and it is the
 * one write an assistant makes on an issue it is not otherwise changing, for
 * example when reporting what a run found.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { issueRefSchema, resolveIssue, resolveIssueActor, resolveWorkspaceId } from "./_core"

const schema = z.object({
  issue: issueRefSchema,
  body: z.string().min(1).max(4000).describe("Comment body. Markdown is preserved."),
})

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.comment",
  family: "issue",
  label: { en: "Comment on issue", "zh-CN": "评论议题" },
  description: {
    en: "Append a comment to an issue's activity trail, attributed to the assistant. Use it to record findings, progress or a question without changing the issue's fields.",
    "zh-CN":
      "在议题的活动记录中追加一条以助手身份署名的评论，用于记录发现、进展或疑问，不改动议题字段。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_comment",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const issue = await resolveIssue(args.issue, workspaceId)
    const by = await resolveIssueActor(ctx)

    // Not a bulk action: `IssueBulkAction` has no comment member, because a
    // comment carries a body per row and so has no bulk meaning. The
    // capability bit is asked here instead.
    const { toUnifiedIssue } = await import("@/lib/issues/sources/local-source")
    if (!toUnifiedIssue(issue).capabilities.canComment) {
      return { status: "refused", reason: "federated-read-only", identifier: issue.identifier }
    }

    const { addIssueComment } = await import("@/lib/db/issues")
    await addIssueComment(issue.id, args.body, by)
    return { status: "added", identifier: issue.identifier, by }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_comment_${Date.now().toString(36)}`,
      title: "Comment on issue",
      summary: `Add a comment to ${args.issue}.`,
      details: [{ label: "Comment", value: args.body.slice(0, 200) }],
    }),
}

registerBuiltInSkill(skill)
