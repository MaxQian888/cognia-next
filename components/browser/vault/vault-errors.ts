import { userPresenceErrorCode } from "@/lib/browser/passwords"

/**
 * Which presence failure a rejected reveal / copy / export represents, as the
 * suffix of a `browserVault.presence.*` translation key (ADR-0201).
 *
 * Rust rejects with a `UserPresenceError` code in the error string
 * (`user_presence_denied`, `user_presence_unavailable`, `user_presence_cancelled`);
 * any other `user_presence*` failure (the platform check itself erroring) is
 * `failed`. Anything else is not a presence failure and returns `null`, so the
 * caller shows its own generic error instead.
 */
export type PresenceFailure = "denied" | "unavailable" | "cancelled" | "failed"

export function presenceFailure(error: unknown): PresenceFailure | null {
  switch (userPresenceErrorCode(error)) {
    case "user_presence_denied":
      return "denied"
    case "user_presence_unavailable":
      return "unavailable"
    case "user_presence_cancelled":
      return "cancelled"
    default: {
      const message =
        error instanceof Error ? error.message : typeof error === "string" ? error : ""
      return message.includes("user_presence") ? "failed" : null
    }
  }
}
