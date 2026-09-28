/** Preserve messages from Error instances and cross-realm error records. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && error.message != null)
    return String(error.message)
  return String(error)
}

export function errorStack(error: unknown): string {
  if (error && typeof error === "object" && "stack" in error && error.stack != null)
    return String(error.stack)
  return errorMessage(error)
}
