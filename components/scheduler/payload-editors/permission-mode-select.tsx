"use client"

import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { SendOptions } from "@cognia/agent-config-types"
import type { ExternalAgentProtocol } from "@/types/agent/external-agent"
import { supportedPermissionModes } from "@/lib/ai/agent/external/permission-modes"
import type { PermissionMode } from "@/lib/settings/permission-mode-escalation"
import { permissionRiskMarker } from "@/lib/settings/permission-mode-meta"

const SDK_MODES: NonNullable<SendOptions["permissionMode"]>[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]

const ACP_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"] as const

export interface PermissionModeSelectProps {
  /**
   * `sdk` covers the four SDK-side modes used by chat / agent / skill tasks;
   * `acp` adds the extra `dontAsk` value used by external ACP agents. Ignored
   * when `protocol` is supplied.
   */
  flavor?: "sdk" | "acp"
  /**
   * When set, the option list is narrowed to the modes the chosen external-agent
   * backend can actually enforce (e.g. Codex has no `dontAsk`). Takes precedence
   * over `flavor`.
   */
  protocol?: ExternalAgentProtocol
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
  protocol,
  value,
  onChange,
  disabled,
  placeholderKey = "permissionModeUseDefault",
  testId,
}: PermissionModeSelectProps) {
  const t = useTranslations("scheduler")
  const modes: readonly string[] = protocol
    ? supportedPermissionModes(protocol)
    : flavor === "acp"
      ? ACP_MODES
      : SDK_MODES

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
        {modes.map((m) => {
          const marker = permissionRiskMarker(m as PermissionMode)
          return (
            <SelectItem key={m} value={m as string}>
              <span className="flex items-center gap-1.5">
                {marker && (
                  <span
                    aria-hidden
                    className={marker === "⚠" ? "text-rose-500" : "text-muted-foreground"}
                  >
                    {marker}
                  </span>
                )}
                {t(`permissionModes.${m}`)}
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
