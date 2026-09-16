"use client"

// Composer chip for the Router + Fusion run mode of this conversation
// (ADR-0188 B3, D23): Auto, Direct, Cascade or Panel.
//
// Auto lets the router decide — a direct turn unless a cascade or panel rule
// the person approved matches. Cascade and Panel ask for a verified run
// explicitly: text only, no agent tools, and the answer appears once it is
// checked. The choice is remembered per conversation on this device.
//
// Renders nothing while Router + Fusion chat is off, and wherever the send
// path would ignore the choice: an external agent runtime, or a shell other
// than the desktop app, never routes a chat turn through Router + Fusion. A
// paused surface keeps the chip, flagged, because an explicit cascade or panel
// is refused rather than quietly answered by an ordinary turn.

import { useTranslations } from "next-intl"
import { AlertTriangle, Route } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { routerFusionGate } from "@/lib/router-fusion/gate/feature-gate"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import {
  CHAT_FUSION_MODES,
  isChatFusionMode,
  useChatFusionMode,
  useChatFusionModeStore,
} from "@/stores/chat/fusion-mode-store"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@cognia/agent-config-types"

interface FusionModeChipProps {
  session: ChatSession | null
  /** The conversation runs on the built-in runtime; external agents never take the choice. */
  builtinRuntime: boolean
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
}

export function FusionModeChip({
  session,
  builtinRuntime,
  disabled,
  className,
}: FusionModeChipProps) {
  const t = useTranslations("routerFusion.modePicker")
  const gate = useSettingsStore((state) => routerFusionGate(state.settings, "chat"))
  const mode = useChatFusionMode(session?.id)
  const setMode = useChatFusionModeStore((state) => state.setMode)

  if (gate === "off" || !session?.id || !builtinRuntime || !isTauri()) return null
  if (session.kind === "workflow-editor") return null
  const sessionId = session.id
  const tripped = gate === "tripped"
  const label = t(mode)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={t("aria", { mode: label })}
          data-testid="fusion-mode-chip"
          data-mode={mode}
          className={cn(
            "gap-1",
            tripped && mode !== "auto" && "text-amber-600 dark:text-amber-400",
            className
          )}
        >
          {tripped && mode !== "auto" ? (
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          ) : (
            <Route className="size-3.5 shrink-0 opacity-70" aria-hidden />
          )}
          {/* Label only when not the default, like the other shape chips. */}
          {mode !== "auto" ? <span className="truncate">{label}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72" data-testid="fusion-mode-menu">
        <DropdownMenuLabel className="text-xs">{t("title")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => {
            if (isChatFusionMode(value)) setMode(sessionId, value)
          }}
        >
          {CHAT_FUSION_MODES.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              data-testid={`fusion-mode-${option}`}
              className="items-start py-1.5"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-xs font-medium">{t(option)}</span>
                <span className="text-[11px] text-muted-foreground">{t(`${option}Desc`)}</span>
              </div>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-[11px] text-muted-foreground">{t("buffered")}</p>
        {tripped ? (
          <p
            className="px-2 pb-1 text-[11px] text-amber-600 dark:text-amber-400"
            data-testid="fusion-mode-paused"
          >
            {t("paused")}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
