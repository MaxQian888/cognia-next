/**
 * `/stack` controller — stacked branches, from the terminal.
 *
 * A stack is a chain of branches where each one is based on the one below it.
 * The record lives in the repository's own config as
 * `branch.<name>.cognia-parent`, which is the same key the desktop app writes:
 * a chain built here shows up in the Stacks panel, and one built there is
 * operable from here. That only works because the record is git's, not a
 * database's.
 *
 * Everything is a direct argv `git` call. The CLI deliberately does not depend
 * on `cognia-git` — that crate vendors libgit2 and would put a C toolchain in
 * the way of `npm i -g` — and the operations here are ones the git binary does
 * better anyway (hooks, credential manager, signing).
 *
 * Local only. Opening the pull requests is `/pr`, which reads the parent
 * pointer this command writes so a stacked branch does not get flattened onto
 * the trunk.
 *
 * CLI is English-only.
 */
import { runGit as defaultRunGit, type ExecResult } from "../../agent/run-git"
import type { TuiAction } from "../state/types"

export interface StackDeps {
  dispatch: (action: TuiAction) => void
  cwd: string
  /** The verb: "" / "list" | "on" | "off" | "check" | "restack" | "push". */
  action?: string
  /** Verb argument — the parent branch for `on`, the remote for `push`. */
  arg?: string
  /** Argv git runner (defaults to the real one; faked in tests). */
  runGit?: (args: string[], cwd: string) => Promise<ExecResult>
}

const PARENT_KEY = (branch: string) => `branch.${branch}.cognia-parent`

const gitOf = (deps: StackDeps) =>
  deps.runGit ?? ((args: string[], cwd: string) => defaultRunGit(args, cwd))

/**
 * A branch name git will accept, checked rather than trusted.
 *
 * Every value below is interpolated into an argv list, and a name beginning
 * with `-` would be read as a flag by whichever git command received it.
 */
export function isValidBranchName(name: string): boolean {
  if (!name || name.startsWith("-")) return false
  if (name.endsWith("/") || name.endsWith(".lock")) return false
  return !/[\s~^:?*[\\]|\.\./.test(name)
}

/** Every recorded pointer in this repository, as `[child, parent]`. */
export async function readParents(deps: StackDeps): Promise<Array<[string, string]>> {
  const res = await gitOf(deps)(
    ["config", "--get-regexp", "^branch\\..*\\.cognia-parent$"],
    deps.cwd
  )
  // Exit 1 means "no matching key", which is an empty repository of stacks
  // rather than a failure.
  if (res.code !== 0) return []
  const pairs: Array<[string, string]> = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const space = trimmed.indexOf(" ")
    if (space < 0) continue
    const key = trimmed.slice(0, space)
    const parent = trimmed.slice(space + 1).trim()
    // `branch.<name>.cognia-parent` — the name itself may contain dots, so
    // strip the fixed prefix and suffix instead of splitting on ".".
    if (!key.startsWith("branch.") || !key.endsWith(".cognia-parent")) continue
    const child = key.slice("branch.".length, -".cognia-parent".length)
    if (child && parent) pairs.push([child, parent])
  }
  return pairs
}

export interface StackChain {
  /** Bottom layer first. */
  layers: string[]
  /** The branch the bottom layer sits on — not itself a layer. */
  trunk: string
}

/**
 * Every chain the pointers describe, each bottom layer first.
 *
 * A branch with two children is two chains sharing a prefix, because that is
 * what it is: two independent things to land that happen to rest on the same
 * work. A pointer cycle is dropped rather than thrown — it is corrupt data one
 * `git config --unset` fixes, and refusing to show any chain because one is
 * broken hides the ones that are fine.
 */
export function chainsFrom(pairs: ReadonlyArray<readonly [string, string]>): StackChain[] {
  const parentOf = new Map(pairs.map(([child, parent]) => [child, parent]))
  const hasChild = new Set(pairs.map(([, parent]) => parent))
  const chains: StackChain[] = []
  for (const [tip] of pairs) {
    if (hasChild.has(tip)) continue
    const chain = walkDown(tip, parentOf)
    if (chain) chains.push(chain)
  }
  return chains.sort((left, right) =>
    (left.layers.at(-1) ?? "").localeCompare(right.layers.at(-1) ?? "")
  )
}

function walkDown(tip: string, parentOf: Map<string, string>): StackChain | null {
  const layers: string[] = []
  const visited = new Set<string>()
  let current = tip
  for (;;) {
    if (visited.has(current)) return null
    visited.add(current)
    layers.unshift(current)
    const parent = parentOf.get(current)
    if (!parent) return null
    if (!parentOf.has(parent)) return { layers, trunk: parent }
    current = parent
  }
}

/** The chain the branch belongs to, or null when it is not stacked. */
export function chainContaining(chains: StackChain[], branch: string): StackChain | null {
  return chains.find((chain) => chain.layers.includes(branch)) ?? null
}

async function currentBranch(deps: StackDeps): Promise<string | null> {
  const res = await gitOf(deps)(["rev-parse", "--abbrev-ref", "HEAD"], deps.cwd)
  const name = res.stdout.trim()
  return res.code === 0 && name && name !== "HEAD" ? name : null
}

/** The parent recorded for a branch, or null. */
export async function parentOf(deps: StackDeps, branch: string): Promise<string | null> {
  const res = await gitOf(deps)(["config", "--get", PARENT_KEY(branch)], deps.cwd)
  const value = res.stdout.trim()
  return res.code === 0 && value ? value : null
}

function notice(deps: StackDeps, message: string): void {
  deps.dispatch({ type: "NOTICE", message })
}

/** `/stack` — print every chain, marking the one HEAD is on. */
async function listChains(deps: StackDeps): Promise<void> {
  const chains = chainsFrom(await readParents(deps))
  if (chains.length === 0) {
    notice(deps, "No stacks recorded here. Use `/stack on <branch>` to record a parent.")
    return
  }
  const head = await currentBranch(deps)
  const lines: string[] = []
  for (const chain of chains) {
    lines.push(chain.trunk)
    chain.layers.forEach((layer, index) => {
      const marker = layer === head ? " ←" : ""
      lines.push(`${"  ".repeat(index + 1)}└ ${layer}${marker}`)
    })
  }
  notice(deps, lines.join("\n"))
}

/** `/stack on <parent>` — record the current branch's parent. */
async function recordParent(deps: StackDeps): Promise<void> {
  const parent = deps.arg?.trim()
  if (!parent) {
    notice(deps, "Usage: /stack on <parent-branch>")
    return
  }
  if (!isValidBranchName(parent)) {
    notice(deps, `Not a valid branch name: ${parent}`)
    return
  }
  const branch = await currentBranch(deps)
  if (!branch) {
    notice(deps, "Detached HEAD — check out the branch you want to stack first.")
    return
  }
  if (branch === parent) {
    notice(deps, `A branch cannot be stacked on itself (${branch}).`)
    return
  }
  const git = gitOf(deps)
  const exists = await git(["rev-parse", "--verify", "--quiet", parent], deps.cwd)
  if (exists.code !== 0) {
    notice(deps, `No such branch: ${parent}`)
    return
  }
  // A cycle would make the chain unwalkable. Refusing here is cheaper than
  // dropping the chain silently every time it is read.
  const chains = chainsFrom([...(await readParents(deps)), [branch, parent]])
  if (!chainContaining(chains, branch)) {
    notice(deps, `Recording ${parent} as ${branch}'s parent would make a loop.`)
    return
  }
  const res = await git(["config", PARENT_KEY(branch), parent], deps.cwd)
  if (res.code !== 0) {
    notice(deps, `Could not record the parent: ${res.stderr.trim() || `git exited ${res.code}`}`)
    return
  }
  notice(deps, `${branch} is stacked on ${parent}.`)
}

/** `/stack off` — clear the current branch's parent. */
async function clearParent(deps: StackDeps): Promise<void> {
  const branch = await currentBranch(deps)
  if (!branch) {
    notice(deps, "Detached HEAD — check out a branch first.")
    return
  }
  const res = await gitOf(deps)(["config", "--unset", PARENT_KEY(branch)], deps.cwd)
  // Exit 5 is "the key was not there", which is the state the verb wanted.
  if (res.code !== 0 && res.code !== 5) {
    notice(deps, `Could not clear the parent: ${res.stderr.trim() || `git exited ${res.code}`}`)
    return
  }
  notice(deps, `${branch} is no longer stacked.`)
}

/**
 * `/stack check` — ask git whether each layer really contains its parent.
 *
 * A parent pointer is a claim. The branch may have been rebased, reset or
 * force-pushed since it was written, and publishing a stack whose layers do not
 * contain each other produces pull requests whose diffs silently include their
 * parents' work.
 */
async function checkChain(deps: StackDeps): Promise<void> {
  const branch = await currentBranch(deps)
  if (!branch) {
    notice(deps, "Detached HEAD — check out a stacked branch first.")
    return
  }
  const chain = chainContaining(chainsFrom(await readParents(deps)), branch)
  if (!chain) {
    notice(deps, `${branch} is not stacked. Use \`/stack on <branch>\` to record a parent.`)
    return
  }
  const git = gitOf(deps)
  const problems: string[] = []
  const bases = [chain.trunk, ...chain.layers]
  for (const [index, layer] of chain.layers.entries()) {
    const parent = bases[index]
    const head = await git(["rev-parse", "--verify", "--quiet", layer], deps.cwd)
    if (head.code !== 0) {
      problems.push(`${layer}: branch is missing`)
      continue
    }
    const contains = await git(["merge-base", "--is-ancestor", parent, layer], deps.cwd)
    if (contains.code !== 0) problems.push(`${layer}: behind ${parent} — restack`)
  }
  if (problems.length === 0) {
    notice(deps, `${chain.layers.join(" → ")} on ${chain.trunk}: every layer contains its parent.`)
    return
  }
  notice(deps, [`${chain.layers.length} layer(s) on ${chain.trunk}:`, ...problems].join("\n"))
}

/**
 * `/stack restack` — replay each layer onto the one below it.
 *
 * `rebase --onto <parent> <old parent tip> <layer>`, bottom first, with the
 * previous tip captured BEFORE anything moves. Using the already-moved parent
 * as the upstream replays its commits a second time, which is how a restack
 * turns a three-commit stack into a six-commit one.
 *
 * `--update-refs` is deliberately not used: it refuses to update a branch
 * checked out in another worktree, and this application cuts a worktree per
 * task, so in the case that matters most it silently skips what it was asked
 * to move.
 */
async function restackChain(deps: StackDeps): Promise<void> {
  const branch = await currentBranch(deps)
  if (!branch) {
    notice(deps, "Detached HEAD — check out a stacked branch first.")
    return
  }
  const chain = chainContaining(chainsFrom(await readParents(deps)), branch)
  if (!chain) {
    notice(deps, `${branch} is not stacked.`)
    return
  }
  const git = gitOf(deps)
  const dirty = await git(["status", "--porcelain"], deps.cwd)
  if (dirty.stdout.trim()) {
    notice(deps, "Working tree is not clean — commit or set the changes aside before restacking.")
    return
  }

  // Every tip as it stands now. The upstream for layer n is its parent's tip
  // from BEFORE the restack started, not the one the previous iteration moved.
  const tips = new Map<string, string>()
  for (const name of [chain.trunk, ...chain.layers]) {
    const res = await git(["rev-parse", "--verify", "--quiet", name], deps.cwd)
    if (res.code !== 0) {
      notice(deps, `Cannot restack: ${name} does not exist.`)
      return
    }
    tips.set(name, res.stdout.trim())
  }

  const bases = [chain.trunk, ...chain.layers]
  const moved: string[] = []
  for (const [index, layer] of chain.layers.entries()) {
    const parent = bases[index]
    const upstream = tips.get(parent)!
    const res = await git(["rebase", "--onto", parent, upstream, layer], deps.cwd)
    if (res.code !== 0) {
      notice(
        deps,
        [
          `Restack stopped at ${layer}.`,
          res.stderr.trim() || `git rebase exited ${res.code}`,
          "Resolve the conflict, then `git rebase --continue`, or `git rebase --abort`.",
          moved.length > 0 ? `Already moved: ${moved.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      )
      return
    }
    moved.push(layer)
  }
  // Rebasing leaves HEAD on the last layer; put the user back where they were.
  await git(["checkout", branch], deps.cwd)
  notice(deps, `Restacked ${moved.join(" → ")} onto ${chain.trunk}.`)
}

/**
 * `/stack push [remote]` — push every layer with a lease.
 *
 * `--force-with-lease` alone is defeated by a background `git fetch`: it
 * compares against the remote-tracking ref, which the fetch has already
 * updated, so the lease is satisfied by work nobody has seen.
 * `--force-if-includes` additionally requires that the local branch contains
 * what the tracking ref points at. It is probed rather than assumed — it is
 * absent before git 2.30 — and its absence is reported rather than hidden.
 */
async function pushChain(deps: StackDeps): Promise<void> {
  const branch = await currentBranch(deps)
  if (!branch) {
    notice(deps, "Detached HEAD — check out a stacked branch first.")
    return
  }
  const chain = chainContaining(chainsFrom(await readParents(deps)), branch)
  if (!chain) {
    notice(deps, `${branch} is not stacked.`)
    return
  }
  const remote = deps.arg?.trim() || "origin"
  if (!isValidBranchName(remote)) {
    notice(deps, `Not a valid remote name: ${remote}`)
    return
  }
  const git = gitOf(deps)
  const help = await git(["push", "-h"], deps.cwd)
  const hasIfIncludes = `${help.stdout}${help.stderr}`.includes("force-if-includes")
  const lease = hasIfIncludes
    ? ["--force-with-lease", "--force-if-includes"]
    : ["--force-with-lease"]

  const res = await git(["push", ...lease, "--set-upstream", remote, ...chain.layers], deps.cwd)
  if (res.code !== 0) {
    notice(deps, `Push refused: ${res.stderr.trim() || `git exited ${res.code}`}`)
    return
  }
  notice(
    deps,
    [
      `Pushed ${chain.layers.join(", ")} to ${remote}.`,
      hasIfIncludes
        ? ""
        : "This git has no --force-if-includes; the lease is the weaker kind a background fetch can satisfy.",
    ]
      .filter(Boolean)
      .join("\n")
  )
}

export async function runStack(deps: StackDeps): Promise<void> {
  switch (deps.action) {
    case "on":
      return recordParent(deps)
    case "off":
      return clearParent(deps)
    case "check":
      return checkChain(deps)
    case "restack":
      return restackChain(deps)
    case "push":
      return pushChain(deps)
    default:
      return listChains(deps)
  }
}
