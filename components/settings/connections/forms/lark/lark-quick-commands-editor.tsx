"use client"

/**
 * Lark adapter wrapper around the shared `QuickCommandsEditor`. Kept as a
 * named export so existing imports under `forms/lark/` continue to work
 * after the cross-adapter lift (im-a2ui-abstract-anchor Phase 2).
 *
 * The Lark help paragraph ("Configure in Feishu console; subscribe
 * application.bot.menu_v6 …") lives in the adapter-specific i18n
 * namespace; everything else (labels, placeholders, aria text) is
 * resolved by the shared editor against
 * `settings.connections.quickCommands.*`.
 */

import { useTranslations } from "next-intl"
import { QuickCommandsEditor } from "@/components/settings/connections/forms/_shared/quick-commands-editor"
import type { IMQuickCommand } from "@/lib/connectors/quick-commands"

export interface LarkQuickCommandsEditorProps {
  value: IMQuickCommand[]
  onChange: (next: IMQuickCommand[]) => void
  disabled?: boolean
}

export function LarkQuickCommandsEditor({
  value,
  onChange,
  disabled,
}: LarkQuickCommandsEditorProps) {
  const t = useTranslations("settings.connections.lark.quickCommands")
  return (
    <QuickCommandsEditor
      value={value}
      onChange={onChange}
      helpText={t("help")}
      disabled={disabled}
      testIdPrefix="lqc"
    />
  )
}
