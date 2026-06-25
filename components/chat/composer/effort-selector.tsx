"use client"

// Composer reasoning-effort ("thinking level") selector — a small dropdown
// next to the model picker in `bottom-toolbar.tsx`. Surfaces the per-session
// `ChatSession.effort` field, which `resolveSendOptions` consumes at send time
// (so a change applies from the NEXT turn — there is no live-apply IPC, unlike
// model switching). Self-gates to nothing when the active model can't use
// effort or there is no session, so it never clutters the toolbar.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { BrainIcon, ChevronsUpDownIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { updateSession } from "@/lib/db/sessions"
import { modelSupportsEffort } from "@/lib/ai/reasoning-capability"
import type { ChatSession, SendOptions } from "@/lib/claude/types"
import { EFFORT_LEVELS } from "@/components/settings/presets/editor-sections/constants"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type EffortValue = NonNullable<SendOptions["effort"]>
/** Sentinel for the "use model default" radio item (maps to `undefined`). */
const DEFAULT_SENTINEL = "__default__"

interface EffortSelectorProps {
  session: ChatSession | null
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
}

export function EffortSelector({ session, disabled, className }: EffortSelectorProps) {
  const t = useTranslations("chat.composer.effort")
  const tEffort = useTranslations("settings.general")
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)

  // Optimistic overlay so the trigger label reflects the selection immediately,
  // before the parent re-renders with the updated session prop. `null` = no
  // overlay; the wrapped value may itself be `undefined` ("use model default").
  const [optimistic, setOptimistic] = useState<{ value: EffortValue | undefined } | null>(null)
  // Reset the overlay when the session changes (render-time setState — the same
  // pattern the model picker uses).
  const [prevSessionId, setPrevSessionId] = useState(session?.id)
  if (prevSessionId !== session?.id) {
    setPrevSessionId(session?.id)
    setOptimistic(null)
  }

  // Mirrors the toolbar's model resolution: per-session override > app default.
  const modelId = session?.model ?? defaultModel ?? "claude-sonnet-4-5"
  const providerId = session?.providerOverride ?? defaultProvider ?? "anthropic"

  // Self-gate: nothing to configure without a session, and the field is a no-op
  // on models the SDK won't accept effort for.
  if (!session?.id) return null
  if (!modelSupportsEffort(providerId, modelId)) return null

  const current = optimistic ? optimistic.value : session.effort
  const triggerLabel = current ? tEffort(`effort.${current}` as `effort.${EffortValue}`) : t("auto")

  const handleSelect = (next: EffortValue | undefined) => {
    setOptimistic({ value: next })
    // Revert the optimistic label if the write doesn't land, so the trigger
    // never shows an effort level the session didn't actually persist.
    void updateSession(session.id, { effort: next }).catch(() => setOptimistic(null))
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          className={cn(
            "h-6 min-w-0 max-w-full gap-1.5 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground",
            className
          )}
          aria-label={t("aria")}
        >
          <BrainIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronsUpDownIcon className="size-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[10rem]">
        <DropdownMenuRadioGroup
          value={current ?? DEFAULT_SENTINEL}
          onValueChange={(v) =>
            handleSelect(v === DEFAULT_SENTINEL ? undefined : (v as EffortValue))
          }
        >
          <DropdownMenuRadioItem value={DEFAULT_SENTINEL}>{t("auto")}</DropdownMenuRadioItem>
          {EFFORT_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={level}>
              {tEffort(`effort.${level}` as `effort.${EffortValue}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
