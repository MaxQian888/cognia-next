import { assertAccountId } from "@/lib/accounts/account-types"

export interface RuntimeTargetScope {
  accountId: string
  targetId: string
}

const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/

let activeScope: RuntimeTargetScope | null = null

export function setActiveRuntimeTargetContext(accountId: string, targetId: string): void {
  activeScope = {
    accountId: assertAccountId(accountId),
    targetId: assertTargetId(targetId),
  }
}

export function getActiveRuntimeTargetContext(): RuntimeTargetScope | null {
  return activeScope ? { ...activeScope } : null
}

export function clearActiveRuntimeTargetContext(): void {
  activeScope = null
}

function assertTargetId(targetId: string): string {
  if (!TARGET_ID_PATTERN.test(targetId)) {
    throw new Error("Invalid runtime target id.")
  }
  return targetId
}
