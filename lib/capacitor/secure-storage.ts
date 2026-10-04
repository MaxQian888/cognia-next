/**
 * Both native SecureStorage implementations use this exact absence error.
 * Other errors must stay observable: treating an unavailable Keystore as an
 * empty store can overwrite or forget credentials during the next save.
 */
export function isMissingSecureStorageItem(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? error.message
        : undefined
  return message === "Item with given key does not exist"
}

/** Rejection handler for idempotent removal; never suppress a storage failure. */
export function ignoreMissingSecureStorageItem(error: unknown): void {
  if (!isMissingSecureStorageItem(error)) throw error
}
