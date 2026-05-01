"use client"

import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { SendOptions } from "@/lib/claude/types"

const SDK_MODES: SendOptions["permissionMode"][] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]

const ACP_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const

export interface PermissionModeSelectProps {
  /**
   * `sdk` covers the four SDK-side modes used by chat / agent / skill tasks;
   * `acp` adds the extra `dontAsk` value used by external ACP agents.
   */
  flavor?: "sdk" | "acp"
  value: string | undefined
  onChange: (value: string | undefined) => void
  disabled?: boolean
  /** Used as the empty-selection option label. */
  placeholderKey?: string
  testId?: string
}

const SENTINEL_DEFAULT = "__use_default__"

export function PermissionModeSelect({
  flavor = "sdk",
  value,
  onChange,
  disabled,
  placeholderKey = "permissionModeUseDefault",
  testId,
}: PermissionModeSelectProps) {
  const t = useTranslations("scheduler")
  const modes = flavor === "acp" ? ACP_MODES : SDK_MODES

  return (
    <Select
      value={value ?? SENTINEL_DEFAULT}
      onValueChange={(v) => onChange(v === SENTINEL_DEFAULT ? undefined : v)}
      disabled={disabled}
    >
      <SelectTrigger className="h-10" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SENTINEL_DEFAULT}>{t(placeholderKey)}</SelectItem>
        {modes.map((m) => (
          <SelectItem key={m} value={m as string}>
            {t(`permissionModes.${m}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
