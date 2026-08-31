import type { AccountSummary, ProviderId } from "@/types/subscription"

export interface AccountCapabilities {
  activate: boolean
  deactivate: boolean
  setDefault: boolean
  rename: boolean
  bindPreset: boolean
  updateCredential: boolean
  reauthenticate: boolean
  removeLocal: boolean
}

const BASE: AccountCapabilities = {
  activate: true,
  deactivate: true,
  setDefault: true,
  rename: true,
  bindPreset: true,
  updateCredential: true,
  reauthenticate: false,
  removeLocal: true,
}

/**
 * Single action contract for the Account Center and host validation.
 * External discovery pointers are intentionally read-only: their source is
 * owned by another CLI and Cognia must never imply that it can mutate it.
 */
export function accountCapabilities(account: AccountSummary): AccountCapabilities {
  if (account.variant === "opencode-discovered") {
    return {
      activate: false,
      deactivate: false,
      setDefault: false,
      rename: false,
      bindPreset: false,
      updateCredential: false,
      reauthenticate: false,
      removeLocal: true,
    }
  }

  return {
    ...BASE,
    bindPreset: account.provider !== "opencode",
    reauthenticate:
      account.provider === "codex" && account.authMode === "chatgpt" && !account.isExternal,
  }
}

export function providerDisplayOrder(provider: ProviderId): number {
  switch (provider) {
    case "anthropic":
      return 0
    case "codex":
      return 1
    case "opencode":
      return 2
  }
}
