"use client"

/**
 * Conversation header strip for the Inbox detail pane.
 *
 * Left: platform avatar (PlatformBadge) + character chip + conversation name.
 * Middle: mode chip (ModeSwitcher live in Tauri; static disabled badge on web).
 * Right: adapter degradation indicator + policy info chip + overrides gear.
 */

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronLeftIcon,
  LoaderIcon,
  RefreshCwIcon,
  Settings2Icon,
} from "lucide-react"
import { toast } from "sonner"
import { ModeSwitcher } from "./mode-switcher"
import { ProviderModelSwitcher } from "./provider-model-switcher"
import { PolicyInfo } from "./policy-info"
import { PlatformBadge } from "./platform-badge"
import { ConversationOverrideDialog } from "./overrides/conversation-override-dialog"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { useAdapterHealth } from "@/hooks/connectors/use-adapter-health"
import { useLastInboundForConversation } from "@/hooks/connectors/use-last-inbound"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isTauri } from "@/lib/tauri"
import { useCharacter } from "@/lib/data-hooks/context"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { parseConversationKey } from "@/types/connectors/event"
import { requeueAdapter } from "@/lib/connectors/lifecycle"
import { cn } from "@/lib/utils"
import type { ConnectorMode, TriggerPolicy } from "@/types/connectors/policy"
import type { PlatformKind } from "@/types/connectors/platform-kind"

/**
 * Compact "last inbound X ago" chip — Task P2.5.
 *
 * Reuses `useLastInboundForConversation` to read the newest `inbound.received`
 * audit row for the current conversationKey. Hides itself when no inbound has
 * ever landed (empty conversation) so it doesn't crowd the header chrome
 * with `Last message —` placeholders.
 */
function LastInboundChip({ conversationKey }: { conversationKey: string }) {
  const t = useTranslations("inbox.conversationHeader")
  const lastAt = useLastInboundForConversation(conversationKey)
  // Lazy init keeps Date.now() out of the render body; the interval re-ticks
  // the chip every 30s so "5 minutes ago" stays current without polluting
  // the render path with impure reads.
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  if (lastAt === null) return null
  const ageMs = Math.max(0, now - lastAt)
  const label = (() => {
    const minutes = Math.round(ageMs / 60_000)
    if (minutes < 1) return t("lastInboundJustNow")
    if (minutes < 60) return t("lastInboundMinutes", { minutes })
    const hours = Math.round(minutes / 60)
    if (hours < 48) return t("lastInboundHours", { hours })
    const days = Math.round(hours / 24)
    return t("lastInboundDays", { days })
  })()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          className="hidden md:inline-flex text-xs"
          data-testid="conversation-header-last-inbound"
        >
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="text-xs">
        {t("lastInboundTooltip", { time: new Date(lastAt).toLocaleString() })}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Compact degradation badge with a click-to-reconnect Popover.
 *
 * Reuses `useAdapterHealth` (Task 2.1) for the live state pull and
 * `requeueAdapter` (lib/connectors/lifecycle.ts) for the reconnect action,
 * so this stays purely a UI shell — no new live-query or transport plumbing.
 */
function AdapterDegradationBadge({ adapterId }: { adapterId: string }) {
  const t = useTranslations("inbox.conversationHeader")
  const { current } = useAdapterHealth(adapterId)
  const [reconnecting, setReconnecting] = useState(false)
  const desktop = isTauri()

  // Only render when something is actually wrong — running + starting are
  // both healthy states the operator doesn't need to act on.
  if (current.state === "running" || current.state === "starting") return null

  const tint =
    current.state === "down"
      ? "text-destructive border-destructive/40 bg-destructive/10"
      : "text-amber-700 border-amber-300 bg-amber-100 dark:text-amber-300 dark:border-amber-700 dark:bg-amber-900/30"

  const onReconnect = async () => {
    if (!desktop) {
      toast.error(t("reconnectDesktopOnly"))
      return
    }
    setReconnecting(true)
    try {
      const ok = await requeueAdapter(adapterId)
      if (ok) {
        toast.success(t("reconnectQueued"))
      } else {
        toast.error(t("reconnectUnavailable"))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setReconnecting(false)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn("h-7 gap-1 px-2 text-xs", tint)}
          aria-label={t("degradedBadgeAria", { state: current.state })}
          data-testid="conversation-header-degraded"
        >
          <AlertTriangleIcon className="h-3 w-3" aria-hidden />
          {t(`degradedState.${current.state}`)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2 text-xs">
        <p className="font-medium">{t("degradedTitle")}</p>
        <p className="text-muted-foreground">
          {t(`degradedHint.${current.state}`)}
          {current.reason ? ` — ${current.reason}` : ""}
        </p>
        <Button
          type="button"
          size="sm"
          className="w-full"
          onClick={() => void onReconnect()}
          disabled={reconnecting || !desktop}
          data-testid="conversation-header-reconnect"
        >
          {reconnecting ? (
            <LoaderIcon className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="mr-1.5 h-3.5 w-3.5" />
          )}
          {t("reconnectButton")}
        </Button>
      </PopoverContent>
    </Popover>
  )
}

interface ConversationHeaderProps {
  conversationKey: string
  sessionId: string
  title: string
  platform: PlatformKind
  currentMode: ConnectorMode
  policy: TriggerPolicy
  characterId?: string
  /** Current ConversationOverrideRow.providerOverride, if set. */
  providerOverride?: string
  /** Current ConversationOverrideRow.modelOverride, if set. */
  modelOverride?: string
  onModeChange?: (mode: ConnectorMode) => void
}

export function ConversationHeader({
  conversationKey,
  sessionId,
  title,
  platform,
  currentMode,
  policy,
  characterId,
  providerOverride,
  modelOverride,
  onModeChange,
}: ConversationHeaderProps) {
  const t = useTranslations("inbox.conversationHeader")
  const tModes = useTranslations("inbox.modeSwitcher.modes")
  const desktop = isTauri()
  const character = useCharacter(characterId)
  const router = useRouter()
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false)
  const overrideRow = useConversationOverride(conversationKey)
  // The conversationKey carries `${platform}:${adapterId}:${chatId}` — extract
  // the middle segment so the override dialog can audit + namespace correctly.
  let parsedAdapterId = ""
  try {
    parsedAdapterId = parseConversationKey(conversationKey).adapterId
  } catch {
    parsedAdapterId = ""
  }

  // Mobile back: prefer router.back() so we restore the previous Inbox list /
  // scope; fall back to /inbox when this is a fresh deep-link load with no
  // history to pop.
  const handleBack = () => {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back()
    } else {
      router.push("/inbox")
    }
  }

  return (
    <header
      className="flex h-12 shrink-0 items-center gap-2 border-b px-2 md:gap-3 md:px-4"
      data-testid="conversation-header"
    >
      {/* Mobile-only nav cluster: back to the conversation list + open the
       * adapters Sheet. Hidden on md+ where the three-pane shell exposes
       * both surfaces directly. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={handleBack}
        aria-label={t("backToList")}
        data-testid="conversation-header-back"
      >
        <ChevronLeftIcon className="h-4 w-4" />
      </Button>
      <SidebarTrigger
        className="md:hidden"
        aria-label={t("openSidebar")}
        data-testid="conversation-header-open-sidebar"
      />

      {/* Left: platform + character chip + title */}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <PlatformBadge platform={platform} iconOnly />
        {character && (
          <span
            className="flex items-center gap-1.5 min-w-0"
            data-testid="conversation-character-chip"
          >
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
              style={{ backgroundColor: avatarColor(character), color: "white" }}
              aria-hidden
              title={character.name}
            >
              {avatarGlyph(character)}
            </span>
            <span className="truncate text-xs text-muted-foreground" title={character.name}>
              {character.name}
            </span>
          </span>
        )}
        <h2 className="text-sm font-semibold truncate">{title}</h2>
      </div>

      {/* Middle: live ModeSwitcher on desktop, static disabled badge on web */}
      {desktop ? (
        <>
          <ModeSwitcher
            conversationKey={conversationKey}
            sessionId={sessionId}
            currentMode={currentMode}
            onModeChange={onModeChange}
          />
          {/* A6 — per-channel provider/model override (ADR-0009 v41). */}
          <ProviderModelSwitcher
            conversationKey={conversationKey}
            sessionId={sessionId}
            providerOverride={providerOverride}
            modelOverride={modelOverride}
          />
        </>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge
              variant="secondary"
              className="opacity-60"
              data-testid="mode-switcher-disabled"
              aria-disabled="true"
            >
              {tModes(currentMode)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent>{t("modeSwitchDesktopOnly")}</TooltipContent>
        </Tooltip>
      )}

      {/* Right: last-inbound chip + adapter degradation badge + policy + gear */}
      <LastInboundChip conversationKey={conversationKey} />
      {parsedAdapterId && <AdapterDegradationBadge adapterId={parsedAdapterId} />}
      <PolicyInfo policy={policy} />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setOverrideDialogOpen(true)}
            aria-label={t("openOverridesAria")}
            data-testid="conversation-header-overrides"
          >
            <Settings2Icon className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("openOverrides")}</TooltipContent>
      </Tooltip>

      <ConversationOverrideDialog
        open={overrideDialogOpen}
        onOpenChange={setOverrideDialogOpen}
        adapterId={parsedAdapterId}
        conversationKey={conversationKey}
        sessionId={sessionId}
        initialRow={overrideRow ?? null}
      />
    </header>
  )
}
