const ENABLED_VALUE = "true"

/** Production builds fail closed unless shared chat is explicitly enabled. */
export function isSharedChatClientEnabled(
  configuredValue: string | undefined = process.env.NEXT_PUBLIC_SHARED_CHAT_ENABLED,
  environment: string | undefined = process.env.NODE_ENV
): boolean {
  if (configuredValue === undefined) return environment === "test"
  return configuredValue.trim().toLowerCase() === ENABLED_VALUE
}

export function assertSharedChatClientEnabled(): void {
  if (!isSharedChatClientEnabled()) throw new Error("SHARED_CHAT_DISABLED")
}
