import { assertAccountId } from "@/lib/accounts/account-types"

export interface RuntimeTargetScope {
  accountId: string
  targetId: string
  routingGeneration: number
}

const TARGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/

let activeScope: RuntimeTargetScope | null = null
let nextRoutingGeneration = 1

export function setActiveRuntimeTargetContext(
  accountId: string,
  targetId: string,
  routingGeneration?: number
): void {
  const checkedAccountId = assertAccountId(accountId)
  const checkedTargetId = assertTargetId(targetId)
  const sameRoute =
    activeScope?.accountId === checkedAccountId && activeScope.targetId === checkedTargetId
  const generation =
    routingGeneration ?? (sameRoute ? activeScope.routingGeneration : nextRoutingGeneration++)
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Invalid runtime routing generation.")
  }
  activeScope = {
    accountId: checkedAccountId,
    targetId: checkedTargetId,
    routingGeneration: generation,
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
