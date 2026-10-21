import type { ViewContainerOpenErrorCode } from "@cognia/plugin-contract/lib/plugin/api/view-container-errors"
export type { ViewContainerOpenErrorCode } from "@cognia/plugin-contract/lib/plugin/api/view-container-errors"

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
