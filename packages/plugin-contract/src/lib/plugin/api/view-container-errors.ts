/**
 * Refusals from `ctx.ui.openViewContainer(containerId)`.
 *
 * Kept dependency-free (no registry, store or guard) so the plugin SDK root can
 * re-export the type guard without dragging host state into an author bundle.
 * The opener itself lives in `./view-container-api.ts`.
 */

/**
 * - `invalid-id`: the id was not a non-empty string.
 * - `not-registered`: no container with that id is registered (never declared,
 *   or its plugin is disabled).
 * - `foreign`: the id names another plugin's container; a plugin may only open
 *   its own.
 */
export type ViewContainerOpenErrorCode = "invalid-id" | "not-registered" | "foreign"

const VIEW_CONTAINER_OPEN_ERROR_CODES: ReadonlySet<string> = new Set<ViewContainerOpenErrorCode>([
  "invalid-id",
  "not-registered",
  "foreign",
])

/** Why a view container could not be opened. `code` is stable; `message` is for logs. */
export class ViewContainerOpenError extends Error {
  readonly code: ViewContainerOpenErrorCode
  readonly containerId: string

  constructor(code: ViewContainerOpenErrorCode, containerId: string, message: string) {
    super(message)
    this.name = "ViewContainerOpenError"
    this.code = code
    this.containerId = containerId
  }
}

/**
 * True when `value` is a view-container refusal, optionally of one `code`.
 *
 * Checks the shape (`name` + a known `code`) rather than `instanceof`, so it
 * still answers correctly when the error was constructed by another copy of
 * this module — a plugin bundle that inlined its own SDK, or a rejection that
 * crossed the Python host-call boundary as a plain object.
 */
export function isViewContainerOpenError(
  value: unknown,
  code?: ViewContainerOpenErrorCode
): value is ViewContainerOpenError {
  if (value === null || typeof value !== "object") return false
  const candidate = value as { name?: unknown; code?: unknown }
  if (candidate.name !== "ViewContainerOpenError") return false
  if (typeof candidate.code !== "string" || !VIEW_CONTAINER_OPEN_ERROR_CODES.has(candidate.code)) {
    return false
  }
  return code === undefined || candidate.code === code
}
