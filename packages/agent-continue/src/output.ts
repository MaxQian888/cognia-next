/** --format json is model output, not a native tool-event protocol. */
export function parseContinueOutput(raw: string): { text: string; structured: unknown } {
  if (raw.length > 8 * 1024 * 1024) throw new Error("Continue JSON output exceeded the 8 MiB limit")
  let value: unknown
  try {
    value = JSON.parse(raw.trim())
  } catch {
    throw new Error("Continue returned invalid JSON output")
  }
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  if (record?.status === "error" || record?.status === "failed")
    throw new Error(
      typeof record.error === "string" ? record.error : "Continue returned an error response"
    )
  return {
    text: typeof record?.response === "string" ? record.response : JSON.stringify(value),
    structured: value,
  }
}
