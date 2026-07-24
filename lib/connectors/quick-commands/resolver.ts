/**
 * First-match resolver — given a normalised command list and an inbound
 * trigger key from the platform, return the matching command or
 * undefined. Adapter-configured rows are consulted first; the reserved
 * `cognia.*` built-ins fill in behind them so console-configured menus
 * work without any adapter-side mapping (and operators can still shadow
 * a reserved key with their own row).
 */

import { BUILT_IN_QUICK_COMMANDS } from "./built-ins"
import type { IMQuickCommand } from "./types"

export function resolveQuickCommand(
  commands: IMQuickCommand[] | undefined,
  triggerKey: string
): IMQuickCommand | undefined {
  return (
    commands?.find((c) => c.triggerKey === triggerKey) ??
    BUILT_IN_QUICK_COMMANDS.find((c) => c.triggerKey === triggerKey)
  )
}
