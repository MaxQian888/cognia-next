"use client"

/**
 * SessionMetaChips — surfaces a fleet session's model and permission mode as
 * two compact chips beneath the row's lead line. Both fields ride in every
 * snapshot (`registry.rs` captures `model` / `permission_mode` off the hook
 * payload) but had no renderer until now.
 *
 * The model chip shows the short brand label (`formatModelLabel`). The mode
 * chip renders only for a recognized, non-`default` mode — the norm carries no
 * signal — and is tinted by the shared permission-mode risk tier
 * (`lib/settings/permission-mode-meta.ts`), so a session running in
 * `bypassPermissions` reads as a rose ⚠ chip you can't miss. The chip label
 * reuses the single-source `chat.permissionMode.*` copy rather than a second
 * drifting list.
 */

import { useTranslations } from "next-intl"
import { formatModelLabel } from "@/lib/fleet/format"
import {
  PERMISSION_MODE_META,
  permissionModeMeta,
  permissionRiskMarker,
} from "@/lib/settings/permission-mode-meta"
import type { PermissionMode } from "@/lib/settings/permission-mode-escalation"
import type { FleetSession } from "@/lib/fleet/types"
import { cn } from "@/lib/utils"

/** Chip appearance per mode, keyed by the shared meta's i18n key. */
const MODE_CHIP: Record<ReturnType<typeof permissionModeMeta>["i18nKey"], string> = {
  default: "border-white/15 bg-white/10 text-white/60",
  plan: "border-amber-400/30 bg-amber-500/15 text-amber-200",
  acceptEdits: "border-blue-400/30 bg-blue-500/15 text-blue-200",
  auto: "border-violet-400/30 bg-violet-500/15 text-violet-200",
  dontAsk: "border-teal-400/30 bg-teal-500/15 text-teal-200",
  bypass: "border-rose-400/40 bg-rose-500/20 text-rose-200",
}

/** True when a raw mode string is a known mode worth showing (not the default). */
function isNoteworthyMode(mode: string): mode is PermissionMode {
  return mode !== "default" && mode in PERMISSION_MODE_META
}

export function SessionMetaChips({
  session,
  className,
}: {
  session: FleetSession
  className?: string
}) {
  const t = useTranslations("fleet.row.meta")
  const tMode = useTranslations("chat.permissionMode")

  const modelLabel = formatModelLabel(session.model)
  const mode = session.permissionMode
  const noteworthyMode = mode && isNoteworthyMode(mode) ? mode : null

  if (!modelLabel && !noteworthyMode) return null

  return (
    <div
      data-testid="session-meta-chips"
      className={cn("flex flex-wrap items-center gap-1", className)}
    >
      {modelLabel ? (
        <span
          data-testid="session-model-chip"
          aria-label={t("model", { model: modelLabel })}
          className="inline-flex items-center rounded-md border border-white/15 bg-white/10 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white/70"
        >
          {modelLabel}
        </span>
      ) : null}

      {noteworthyMode
        ? (() => {
            const meta = permissionModeMeta(noteworthyMode)
            const marker = permissionRiskMarker(noteworthyMode)
            return (
              <span
                data-testid="session-mode-chip"
                data-mode={noteworthyMode}
                data-risk={meta.risk}
                aria-label={t("permissionMode", { mode: tMode(`${meta.i18nKey}.label`) })}
                className={cn(
                  "inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none",
                  MODE_CHIP[meta.i18nKey]
                )}
              >
                {meta.risk === "danger" && marker ? <span aria-hidden>{marker}</span> : null}
                {tMode(`${meta.i18nKey}.label`)}
              </span>
            )
          })()
        : null}
    </div>
  )
}

export default SessionMetaChips
