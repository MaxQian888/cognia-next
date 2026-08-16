/**
 * Handler sets for the Creator executor (ADR-0117, Phase 3).
 *
 * The executor takes four outside-world ports. Exactly one of them can be
 * satisfied entirely inside the renderer today — `preview`, which runs on the
 * plugin disposable scope that `lib/creator/preview.ts` already implements. The
 * other three need an agent session (generate, survey, review) or a host shell
 * (verify), neither of which the renderer can reach on its own.
 *
 * Rather than stub those with something that silently succeeds, the default set
 * makes them fail loudly and specifically. A step that reports "the generator
 * is not connected on this host" is honest and shows up in the run log; a step
 * that quietly returned an empty plan would let the workflow walk all the way
 * to delivery having produced nothing, which is far worse.
 */

import { CreatorPreviewSession } from "./preview"
import type { CreatorHandlers, CreatorRunContext } from "./executor"

/** Thrown by a port that has no implementation on this host. */
export class CreatorPortUnavailableError extends Error {
  constructor(
    readonly port: keyof CreatorHandlers,
    detail: string
  ) {
    super(`Creator step "${port}" is not connected: ${detail}`)
    this.name = "CreatorPortUnavailableError"
  }
}

function unavailable(port: keyof CreatorHandlers, detail: string): never {
  throw new CreatorPortUnavailableError(port, detail)
}

/**
 * The preview port, backed by the real disposable-scope session.
 *
 * `mount` is supplied by the caller because what a preview *is* depends on the
 * artifact kind — a plugin activates in a scope, a workflow renders a canvas.
 * The lifecycle and the leak check are the same for all of them, which is the
 * part this owns.
 */
export function createPreviewHandler(
  mount: (
    scope: Parameters<ConstructorParameters<typeof CreatorPreviewSession>[0]["mount"]>[0]
  ) => void | Promise<void>
): CreatorHandlers["preview"] {
  return async (ctx: CreatorRunContext) => {
    const session = new CreatorPreviewSession({
      artifactKind: ctx.artifactKind,
      artifactId: ctx.runId,
      mount,
    })
    await session.start()
    const report = await session.dispose()
    return { clean: report.clean, leaked: report.leaked }
  }
}

export type CreatorHandlerOverrides = Partial<CreatorHandlers>

/**
 * Build a handler set, defaulting every unimplemented port to a loud failure.
 *
 * Callers override the ports their host can actually serve. The shape means a
 * newly connected port is a one-line change and an unconnected one can never be
 * mistaken for a working no-op.
 */
export function createCreatorHandlers(overrides: CreatorHandlerOverrides = {}): CreatorHandlers {
  return {
    collectRequirements: async () =>
      unavailable("collectRequirements", "no requirements source is wired"),
    surveyExisting: async () =>
      unavailable("surveyExisting", "needs an agent session to search the codebase"),
    planScaffold: async () =>
      unavailable("planScaffold", "needs an agent session to generate the scaffold"),
    verify: async () => unavailable("verify", "needs a host shell to run the toolchain"),
    preview: async () => unavailable("preview", "no preview mount was supplied"),
    review: async () => unavailable("review", "needs an independent reviewer subagent"),
    deliver: async () => unavailable("deliver", "install/export/publish is not wired"),
    ...overrides,
  }
}

/**
 * A requirements port backed by text the user already typed.
 *
 * Trivial, but real: step 1 genuinely is "write down what you want", and
 * routing it through the same port as the rest keeps the executor's contract
 * uniform.
 */
export function createStaticRequirementsHandler(
  requirements: string
): CreatorHandlers["collectRequirements"] {
  return async () => {
    const trimmed = requirements.trim()
    if (trimmed === "") {
      unavailable("collectRequirements", "the requirements field is empty")
    }
    return { requirements: trimmed }
  }
}
