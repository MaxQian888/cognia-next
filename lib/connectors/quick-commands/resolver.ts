/**
 * First-match resolver — given a normalised command list and an inbound
 * trigger key from the platform, return the matching command or
 * undefined. Trivial enough that the function exists mainly for unit
 * coverage + a single import site across both adapters.
 */

import type { IMQuickCommand } from "./types"

export function resolveQuickCommand(
  commands: IMQuickCommand[] | undefined,
  triggerKey: string
): IMQuickCommand | undefined {
  if (!commands || commands.length === 0) return undefined
  return commands.find((c) => c.triggerKey === triggerKey)
}
