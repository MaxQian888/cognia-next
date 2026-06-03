/**
 * Local Git workflow action nodes (ADR-0038): `action.git.{stage,commit,push,
 * branch}`. They drive the same Source Control backend the panel uses
 * (`lib/git/commands`), so automation flows can commit and push the same way a
 * user would. The repo path defaults to the active workspace root bound in the
 * git store, or can be set explicitly per node via `repoPath`.
 */

import {
  gitCheckoutBranch,
  gitCommit,
  gitCreateBranch,
  gitPush,
  gitStage,
} from "@/lib/git/commands"
import { useGitStore } from "@/stores/git/git-store"
import { registerNodeExecutor } from "./registry"
import type { StepExecutionContext } from "@/types/workflow/visual"

function strParam(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function boolParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const v = params[key]
  return typeof v === "boolean" ? v : undefined
}

function pathsParam(params: Record<string, unknown>): string[] {
  const v = params.paths
  if (!Array.isArray(v)) return ["."]
  const paths = v.filter((x): x is string => typeof x === "string" && x.length > 0)
  return paths.length > 0 ? paths : ["."]
}

/** Resolve the target repo: explicit `repoPath`, else the bound workspace root. */
function resolveRepo(params: Record<string, unknown>): string {
  const explicit = strParam(params, "repoPath")
  if (explicit) return explicit
  const bound = useGitStore.getState().rootDir
  if (bound) return bound
  throw new Error("action.git: no repo (set repoPath or open a folder in Source Control)")
}

registerNodeExecutor({
  kind: "action.git.stage",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = resolveRepo(ctx.params)
    const paths = pathsParam(ctx.params)
    await gitStage(repo, paths)
    return { output: { repoPath: repo, staged: paths } }
  },
})

registerNodeExecutor({
  kind: "action.git.commit",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = resolveRepo(ctx.params)
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
    const repo = resolveRepo(ctx.params)
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
    const repo = resolveRepo(ctx.params)
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
