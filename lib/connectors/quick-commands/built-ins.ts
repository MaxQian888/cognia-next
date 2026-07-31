/**
 * Reserved cross-adapter quick commands (plan 2026-07-24 P4.2).
 *
 * These `cognia.*` trigger keys are what the ops runbook tells admins to use
 * as `event_key`s when configuring bot menus in the platform console, so a
 * fresh install gets working menu entries with zero adapter configuration.
 * Adapter-configured rows always win: the resolver consults these only when
 * the configured list has no match, so an operator can re-map or shadow any
 * reserved key.
 *
 * Labels are bilingual IM literals by convention (follow-up-control) — menu
 * replies go to the platform, not through next-intl.
 */

import type { IMQuickCommand } from "./types"

export const BUILT_IN_QUICK_COMMANDS: readonly IMQuickCommand[] = [
  {
    triggerKey: "cognia.new_task",
    label: "New task / 新任务",
    action: { type: "slash", value: "/new" },
  },
  {
    triggerKey: "cognia.status",
    label: "Status / 状态",
    action: { type: "slash", value: "/status" },
  },
  {
    triggerKey: "cognia.help",
    label: "Help / 帮助",
    action: { type: "slash", value: "/help" },
  },
  {
    triggerKey: "cognia.open_workbench",
    label: "Open workbench / 打开工作台",
    action: { type: "link", value: "/" },
  },
]
