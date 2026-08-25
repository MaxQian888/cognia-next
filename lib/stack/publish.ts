/**
 * Turning a chain of branches into a chain of pull requests.
 *
 * Idempotent by construction. Publishing a stack is something people do
 * repeatedly — after adding a layer, after a restack, after the branch
 * protection settings changed — and a function that creates a second pull
 * request for a branch that already has one is worse than useless. Every layer
 * is looked up first; an existing pull request is retargeted if its base has
 * drifted and left alone if it has not.
 *
 * Bottom first, always. A pull request whose base branch does not exist yet is
 * rejected by the forge, and layer *n*'s base is layer *n-1*.
 */

import { baseBranches, type Stack, type StackLayer } from "./model"
import type { ForgePullRequest, ForgeStackAdapter } from "./forge/types"

export interface PublishStackInput {
  stack: Stack
  /** Repository the pull requests live in, in whatever form the adapter takes. */
  repository: string
  adapter: ForgeStackAdapter
  /** Title for a layer that has none. Defaults to the layer's own title. */
  titleFor?: (layer: StackLayer) => string
  /** Extra body text, appended under the adapter's own stack note. */
  bodyFor?: (layer: StackLayer) => string | undefined
}

export interface PublishedLayer {
  layer: StackLayer
  pullRequest: ForgePullRequest
  /** What happened to it this time round. */
  action: "created" | "retargeted" | "unchanged"
}

export type PublishStackResult =
  /**
   * Only a fork can be pushed to. Not a degraded mode: every layer above the
   * bottom would have to be based on a branch the target repository cannot see.
   */
  | { status: "forkOnly"; repository: string; fork?: string }
  | {
      status: "published"
      layers: PublishedLayer[]
      /** The forge's own stack id, when it took one. */
      nativeStackId?: string
    }

/**
 * The note that makes a stacked pull request readable on its own.
 *
 * Someone opening layer 3 of a stack sees a diff that assumes layers 1 and 2
 * and a base branch they have never heard of. One line saying which layer this
 * is and what it sits on is the difference between "why is this based on
 * `me/b`" and "this is 3 of 4".
 */
export function stackBodyNote(order: number, total: number, baseBranch: string): string {
  return `Stacked pull request ${order + 1} of ${total} — based on \`${baseBranch}\`.`
}

export async function publishStack(input: PublishStackInput): Promise<PublishStackResult> {
  const capabilities = await input.adapter.capabilities(input.repository)
  if (!capabilities.canPushToTarget) {
    return {
      status: "forkOnly",
      repository: input.repository,
      ...(capabilities.forkFullName ? { fork: capabilities.forkFullName } : {}),
    }
  }

  const ordered = [...input.stack.layers].sort((left, right) => left.order - right.order)
  const bases = baseBranches(input.stack)
  const layers: PublishedLayer[] = []

  for (const [index, layer] of ordered.entries()) {
    const baseBranch = bases.get(layer.branch) ?? input.stack.trunk
    const existing = await input.adapter.findByBranch(input.repository, layer.branch)
    if (!existing) {
      const note = stackBodyNote(index, ordered.length, baseBranch)
      const extra = input.bodyFor?.(layer)
      const pullRequest = await input.adapter.createPullRequest({
        repository: input.repository,
        branch: layer.branch,
        baseBranch,
        title: input.titleFor?.(layer) ?? layer.title,
        body: extra ? `${note}\n\n${extra}` : note,
        order: index,
        total: ordered.length,
      })
      layers.push({ layer, pullRequest, action: "created" })
      continue
    }
    if (existing.baseBranch !== baseBranch) {
      await input.adapter.retarget(input.repository, existing.number, baseBranch)
      layers.push({
        layer,
        pullRequest: { ...existing, baseBranch },
        action: "retargeted",
      })
      continue
    }
    layers.push({ layer, pullRequest: existing, action: "unchanged" })
  }

  // Register last: the forge's stack object refers to pull request numbers,
  // and half of them did not exist a moment ago. A forge that declines this
  // particular stack returns null, which is not a failure — the chain of base
  // branches already carries the shape.
  let nativeStackId: string | undefined
  if (capabilities.nativeStacks && input.adapter.registerStack && layers.length > 1) {
    const registered = await input.adapter
      .registerStack(
        input.repository,
        layers.map((entry) => entry.pullRequest.number)
      )
      .catch(() => null)
    if (registered) nativeStackId = registered
  }

  return {
    status: "published",
    layers,
    ...(nativeStackId ? { nativeStackId } : {}),
  }
}
