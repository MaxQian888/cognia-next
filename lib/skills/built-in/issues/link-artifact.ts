/**
 * `issue.link_artifact`: an agent hands over a result from inside its run.
 *
 * Until now only run engines attached artifacts, and only when a run settled
 * (sessions, branches, pull requests). This lets the agent doing the work
 * link what it produced — a Cognia artifact by id, or a URL — as a
 * deliverable of the issue it is running on (`IssueRunArtifact.deliverable`).
 * Deliverables with the same label are versions of one another
 * (`lib/issues/deliverables.ts`), so linking "report.csv" again after
 * revising it adds a version rather than a second deliverable.
 *
 * Accepted only from inside a run: the calling session must be one an active
 * run of the workspace is executing in. That run is where the link lands, so
 * no conversation can attach things to someone else's work.
 */

import { z } from "zod"

import { registerBuiltInSkill } from "../registry"
import type { BuiltInSkill } from "../types"
import { buildConfirmSurface } from "../_shared/confirm-surface"
import { resolveWorkspaceId } from "./_core"

const schema = z
  .object({
    artifactId: z
      .string()
      .min(1)
      .optional()
      .describe("Id of a Cognia artifact you created (from the artifact tool's result)."),
    url: z
      .string()
      .url()
      .optional()
      .describe("An https URL to the result, when it lives outside Cognia."),
    label: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "What to call it, e.g. 'report.csv'. Reusing a label adds a new version of that deliverable. Defaults to the artifact's title."
      ),
  })
  .refine((args) => Boolean(args.artifactId) !== Boolean(args.url), {
    message: "Give exactly one of artifactId or url.",
  })

async function loadArtifact(
  id: string
): Promise<{ id: string; sessionId: string; projectId?: string; title: string } | undefined> {
  const { getDb } = await import("@/lib/db/schema")
  const row = await getDb().artifacts.get(id)
  if (row) return row
  // A just-created artifact may be in the store before its row is written.
  const { useArtifactStore } = await import("@/stores/artifact/artifact-store")
  return useArtifactStore.getState().artifacts[id]
}

const skill: BuiltInSkill<typeof schema> = {
  id: "issue.link_artifact",
  family: "issue",
  label: { en: "Link deliverable to issue", "zh-CN": "关联议题交付物" },
  description: {
    en: "From inside a run on an issue: link a result you produced (a Cognia artifact by id, or an https URL) as a deliverable of that issue. Linking the same label again adds a new version. Refused outside a run.",
    "zh-CN":
      "在议题的运行中使用：把你产出的结果（按 id 指定的 Cognia 产物，或 https 链接）关联为该议题的交付物。再次使用相同名称会新增一个版本。不在运行中时会被拒绝。",
  },
  platforms: "any",
  mutation: "write",
  imAccess: "always",
  mcpToolName: "issue_link_artifact",
  inputSchema: schema,
  execute: async (args, ctx) => {
    const workspaceId = await resolveWorkspaceId(ctx)
    const [{ listIssueRuns, linkIssueRunArtifact }, { issueRunSessionIds }, deliverables] =
      await Promise.all([
        import("@/lib/db/issue-runs"),
        import("@/lib/issues/run/registry"),
        import("@/lib/issues/deliverables"),
      ])

    let run
    for (const candidate of await listIssueRuns({ projectId: workspaceId, activeOnly: true })) {
      if (ctx.sessionId && (await issueRunSessionIds(candidate)).includes(ctx.sessionId)) {
        run = candidate
        break
      }
    }
    if (!run) return { status: "refused", reason: "not-in-run" }

    const now = Date.now()
    if (args.artifactId) {
      const artifact = await loadArtifact(args.artifactId)
      if (!artifact)
        return { status: "refused", reason: "artifact-missing", artifactId: args.artifactId }
      if (artifact.projectId && artifact.projectId !== run.projectId) {
        return {
          status: "refused",
          reason: "artifact-other-workspace",
          artifactId: args.artifactId,
        }
      }
      const label = args.label?.trim() || artifact.title
      await linkIssueRunArtifact(
        run.id,
        {
          label,
          href: deliverables.artifactDeliverableHref(artifact.id),
          artifactId: artifact.id,
          sessionId: artifact.sessionId,
          deliverable: true,
          linkedAt: now,
        },
        now
      )
      return { status: "linked", runId: run.id, issueId: run.issueId, label }
    }

    const url = new URL(args.url!)
    if (url.protocol !== "https:") return { status: "refused", reason: "not-https", url: args.url }
    const label = args.label?.trim() || url.pathname.split("/").filter(Boolean).pop() || url.host
    await linkIssueRunArtifact(
      run.id,
      { label, href: url.toString(), deliverable: true, linkedAt: now },
      now
    )
    return { status: "linked", runId: run.id, issueId: run.issueId, label }
  },
  hitlSurface: (args) =>
    buildConfirmSurface({
      surfaceId: `sfc_issue_link_artifact_${Date.now().toString(36)}`,
      title: "Link deliverable to issue",
      summary: "Attach a result of this run to its issue.",
      details: [
        ...(args.artifactId ? [{ label: "Artifact", value: args.artifactId }] : []),
        ...(args.url ? [{ label: "URL", value: args.url }] : []),
        ...(args.label ? [{ label: "Label", value: args.label }] : []),
      ],
    }),
}

registerBuiltInSkill(skill)
