/** Shared helpers for the Cognia runtime controllers. */

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** Truncate a label to keep the activity pill / select rows compact. */
export function truncate(text: string, max = 60): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}
