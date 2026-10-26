/**
 * Run a view action without leaving its failure unhandled: a busy runtime and
 * a declined confirmation are expected outcomes, shown as a toast like any
 * other error.
 */
import { toast } from "@cognia/plugin-ui"

export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Failures the user can act on, by code; anything else shows its own message. */
const CODED: Record<string, string> = {
  governance_busy: "errors.busy",
  governance_cancelled: "errors.cancelled",
  governance_unparseable: "errors.unparseable",
  agent_config_consent_denied: "errors.declined",
  agent_config_stale: "errors.stale",
  record_too_large: "errors.recordTooLarge",
  unsafe_pattern: "errors.unsafePattern",
}

export function errorMessage(error: unknown, t: Translate): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined
  const key = typeof code === "string" ? CODED[code] : undefined
  if (key) return t(key)
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

export function act(task: Promise<unknown>, t: Translate): void {
  task.catch((error: unknown) => {
    toast.error(errorMessage(error, t))
  })
}
