/**
 * Stacked-branch workflow action nodes (ADR — stacks as first-class):
 * `action.stack.{list,parent,validate,restack,push}`.
 *
 * Local operations only. Publishing and merging a stack talks to a forge, and
 * forge delivery stays in plugin territory (ADR-0018/0026) — reversing that
 * here would put GitHub credentials in the built-in node set. What these do is
 * the half git owns: read the parent pointers, record one, check the ancestry
 * claims against the object graph, move the layers, and push them with a lease.
 *
 * Addressing is `action.git.*`'s (`./repo-target`), so a flow that already
 * commits in a workspace stacks in the same one without saying where twice.
 */

import {
  gitStackParents,
  gitStackPush,
  gitStackRestack,
  gitStackSetParent,
  gitStackValidate,
} from "@/lib/git/commands"
import { discoverStacks, stackIdFor } from "@/lib/stack/discover"
import { validateStack } from "@/lib/stack/validate"
import type { Stack } from "@/lib/stack/model"
import { registerNodeExecutor } from "../registry"
import { resolveRepo, strParam } from "./repo-target"
import type { StepExecutionContext } from "@/types/workflow/visual"

/** A required string param, refused rather than defaulted. */
function requireStr(ctx: StepExecutionContext, key: string, kind: string): string {
  const value = strParam(ctx.params, key)
  if (!value) throw new Error(`${kind}: ${key} is required`)
  return value
}

/**
 * A required non-empty list of branch names.
 *
 * Empty is refused rather than treated as "all of them": a restack that
 * silently widened its scope from nothing to every branch in the repository
 * is the worst possible reading of an author's mistake.
 */
function requireBranches(ctx: StepExecutionContext, kind: string): string[] {
  const raw = ctx.params.branches
  const branches = Array.isArray(raw)
    ? raw.filter((item): item is string => typeof item === "string" && item.length > 0)
    : []
  if (branches.length === 0) throw new Error(`${kind}: branches is required`)
  return branches
}

/** The wire shape of a stack, flattened for `{{ $node[...] }}` consumers. */
function toWorkflowStack(stack: Stack) {
  return {
    id: stack.id,
    trunk: stack.trunk,
    tip: stack.layers[stack.layers.length - 1]?.branch ?? null,
    branches: stack.layers.map((layer) => layer.branch),
    layers: stack.layers.map((layer) => ({ branch: layer.branch, order: layer.order })),
  }
}

/**
 * Resolve the branches a node operates on: an explicit list, or every layer of
 * the stack a named tip belongs to.
 *
 * `tipBranch` exists because the useful automation is "restack whatever is on
 * top of this", and making the author enumerate the layers means the flow goes
 * stale the moment somebody adds one.
 */
async function resolveLayers(
  ctx: StepExecutionContext,
  repo: string,
  kind: string
): Promise<{ branches: string[]; stack?: Stack }> {
  const tip = strParam(ctx.params, "tipBranch")
  if (!tip) return { branches: requireBranches(ctx, kind) }
  const stacks = await discoverStacks({ repositoryRoot: repo })
  const stack = stacks.find((candidate) => candidate.id === stackIdFor(tip))
  if (!stack) throw new Error(`${kind}: no stack found with tip ${tip}`)
  return { branches: stack.layers.map((layer) => layer.branch), stack }
}

registerNodeExecutor({
  kind: "action.stack.list",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    const stacks = await discoverStacks({ repositoryRoot: repo })
    return {
      output: {
        repoPath: repo,
        count: stacks.length,
        stacks: stacks.map(toWorkflowStack),
        // The first one is not "the" stack, but a flow that expects exactly
        // one should not have to index into an array to say so.
        stack: stacks[0] ? toWorkflowStack(stacks[0]) : null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.stack.parent",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    const branch = requireStr(ctx, "branch", "action.stack.parent")
    // An absent or empty `parent` clears the pointer. That is the only way to
    // say "this is the bottom layer now" and it must not be confused with
    // "leave it alone" — the node either writes or clears, every time.
    const parent = strParam(ctx.params, "parent") ?? null
    await gitStackSetParent(repo, branch, parent)
    return { output: { repoPath: repo, branch, parent } }
  },
})

registerNodeExecutor({
  kind: "action.stack.validate",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    const { branches, stack } = await resolveLayers(ctx, repo, "action.stack.validate")
    const states = await gitStackValidate(repo, branches)

    // Without a discovered stack the trunk is whatever the bottom layer's
    // recorded parent says, which is exactly what `discoverStacks` computes —
    // so ask git rather than making the author restate it.
    const parents = stack ? null : new Map(await gitStackParents(repo))
    const trunk = stack?.trunk ?? (branches[0] ? (parents?.get(branches[0]) ?? "HEAD") : "HEAD")
    const layers =
      stack?.layers ??
      branches.map((branch, order) => ({ id: branch, branch, title: branch, order }))

    const verdict = validateStack({ stack: { trunk, layers }, states })
    return {
      output: {
        repoPath: repo,
        trunk,
        branches,
        ok: verdict.ok,
        remedy: verdict.remedy,
        problems: verdict.problems,
        states,
      },
      // Authors branch on the verdict far more often than they read it, so it
      // is a routing decision as well as an output.
      decision: verdict.ok ? "ok" : "problems",
    }
  },
})

registerNodeExecutor({
  kind: "action.stack.restack",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    const { branches, stack } = await resolveLayers(ctx, repo, "action.stack.restack")
    const onto = strParam(ctx.params, "onto") ?? stack?.trunk
    if (!onto) throw new Error("action.stack.restack: onto is required")
    const outcome = await gitStackRestack(repo, onto, branches)
    // A conflict is an outcome, not an exception: the sequencer is mid-flight
    // and a later node (or a person) resolves it. Throwing here would lose the
    // conflict's own description.
    return {
      output: {
        repoPath: repo,
        onto,
        branches,
        method: outcome.method,
        updates: outcome.updates,
        conflict: outcome.conflict,
        restacked: outcome.conflict === null,
      },
      decision: outcome.conflict === null ? "restacked" : "conflict",
    }
  },
})

registerNodeExecutor({
  kind: "action.stack.push",
  typeVersion: 1,
  execute: async (ctx: StepExecutionContext) => {
    const repo = await resolveRepo(ctx)
    const { branches } = await resolveLayers(ctx, repo, "action.stack.push")
    const remote = strParam(ctx.params, "remote") ?? "origin"
    const outcome = await gitStackPush(repo, remote, branches)
    return {
      output: {
        repoPath: repo,
        remote,
        pushed: outcome.pushed,
        // Surfaced, not hidden: on a git without `--force-if-includes` the
        // lease is the weaker kind that a background fetch can satisfy, and a
        // flow that cares can gate on this.
        forceIfIncludes: outcome.forceIfIncludes,
      },
    }
  },
})
