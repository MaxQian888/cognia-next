/**
 * Local Git workflow action nodes (ADR-0038): `action.git.{stage,commit,push,
 * branch}`. They drive the same Source Control backend the panel uses
 * (`lib/git/commands`), so automation flows can commit and push the same way a
 * user would. The repo path comes from `repoPath`, else the node's or the run's
 * workspace, else the folder open in the Source Control panel.
 */

import {
  gitCheckoutBranch,
  gitCommit,
  gitCreateBranch,
  gitPush,
  gitStage,
} from "@/lib/git/commands"
import { registerNodeExecutor } from "../registry"
import { boolParam, pathsParam, resolveRepo, strParam } from "./repo-target"
import type { StepExecutionContext } from "@/types/workflow/visual"

registerNodeExecutor({
  kind: "action.git.stage",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    const paths = pathsParam(ctx.params)
    await gitStage(repo, paths)
    return { output: { repoPath: repo, staged: paths } }
  },
})

registerNodeExecutor({
  kind: "action.git.commit",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    const message = strParam(ctx.params, "message")
    if (!message) throw new Error("action.git.commit: message is required")
    const hash = await gitCommit(repo, message, false, boolParam(ctx.params, "signoff") ?? false)
    return { output: { repoPath: repo, hash, message } }
  },
})

registerNodeExecutor({
  kind: "action.git.push",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    await gitPush(repo, {
      remote: strParam(ctx.params, "remote"),
      branch: strParam(ctx.params, "branch"),
      setUpstream: boolParam(ctx.params, "setUpstream") ?? false,
    })
    return { output: { repoPath: repo, pushed: true } }
  },
})

registerNodeExecutor({
  kind: "action.git.branch",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    const name = strParam(ctx.params, "name")
    if (!name) throw new Error("action.git.branch: name is required")
    const checkout = boolParam(ctx.params, "checkout") ?? true
    const from = strParam(ctx.params, "from")
    // Create the branch (optionally checking it out). If it already exists and
    // we only want to switch, fall back to a plain checkout.
    try {
      await gitCreateBranch(repo, name, checkout, from)
    } catch (err) {
      if (checkout) await gitCheckoutBranch(repo, name)
      else throw err
    }
    return { output: { repoPath: repo, branch: name, checkedOut: checkout } }
  },
})
