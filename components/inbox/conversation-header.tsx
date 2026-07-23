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
import { ChevronLeftIcon, ListChecksIcon, Settings2Icon, UserRoundIcon } from "lucide-react"
import { ModeSwitcher } from "./mode-switcher"
import { LifecycleStatusChip } from "./lifecycle-status-chip"
import { AssigneeChip } from "./assignee-chip"
import { SlaBadge } from "./sla-badge"
import { LabelPicker } from "./label-picker"
import { ContactProfileDrawer } from "./contact-profile-drawer"
import { ProviderModelSwitcher } from "./provider-model-switcher"
import { PolicyInfo } from "./policy-info"
import { PlatformBadge } from "./platform-badge"
import { ConversationOverrideDialog } from "./overrides/conversation-override-dialog"
import { CallbackBindingsInspector } from "./debug/callback-bindings-inspector"
import { ComputerUseToggle } from "./overrides/computer-use-toggle"
import { AdapterHealthBadge } from "./adapter-health-badge"
import { ComputerUseChip } from "./computer-use-chip"
import { QuietHoursChip } from "./quiet-hours-chip"
import { AtStrategyChip } from "./at-strategy-chip"
import { TopicRuntimeChip } from "./topic-runtime-chip"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { effectiveStatus } from "@/lib/db/conversation-overrides"
import { useLastInboundForConversation } from "@/hooks/connectors/use-last-inbound"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ArtifactDockToggle } from "@/components/artifacts/artifact-dock-toggle"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isTauri } from "@/lib/tauri"
import { useCharacter } from "@/lib/data-hooks/context"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { parseConversationKey } from "@/types/connectors/event"
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
  const tBindings = useTranslations("inbox.bindingsInspector")
  const desktop = isTauri()
  const character = useCharacter(characterId)
  const router = useRouter()
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false)
  const [bindingsOpen, setBindingsOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
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

      {/* Right: last-inbound chip + Computer-Use toggle + adapter
       * degradation badge + policy + gear. Computer-Use lives close to
       * the degradation surface so the high-blast-radius opt-in is
       * visible whenever the conversation is open. */}
      <LifecycleStatusChip
        conversationKey={conversationKey}
        sessionId={sessionId}
        status={effectiveStatus(overrideRow)}
      />
      <AssigneeChip
        conversationKey={conversationKey}
        sessionId={sessionId}
        assignee={overrideRow?.assignee}
      />
      <SlaBadge
        nextResponseDueAt={overrideRow?.nextResponseDueAt}
        status={effectiveStatus(overrideRow)}
      />
      <LabelPicker
        conversationKey={conversationKey}
        sessionId={sessionId}
        selectedIds={overrideRow?.labelIds ?? []}
      />
      <LastInboundChip conversationKey={conversationKey} />
      {parsedAdapterId && (
        <QuietHoursChip adapterId={parsedAdapterId} conversationKey={conversationKey} />
      )}
      {parsedAdapterId && <AtStrategyChip adapterId={parsedAdapterId} />}
      {parsedAdapterId && (
        <TopicRuntimeChip adapterId={parsedAdapterId} conversationKey={conversationKey} />
      )}
      {parsedAdapterId && desktop && (
        <ComputerUseToggle
          conversationKey={conversationKey}
          sessionId={sessionId}
          adapterId={parsedAdapterId}
          currentValue={overrideRow?.allowComputerUse === true}
        />
      )}
      {/* Web-mode mirror of the computer-use opt-in — read-only chip so
       * the operator still sees the elevated-permission state even when
       * the biometric toggle isn't available (web build / mobile shell). */}
      {!desktop && <ComputerUseChip active={overrideRow?.allowComputerUse === true} />}
      {/* v49 — replaces inline AdapterDegradationBadge with the wider
       * health surface that picks up breaker / rate-bucket signals from
       * the heartbeat snapshots, not just the current.state. */}
      {parsedAdapterId && <AdapterHealthBadge adapterId={parsedAdapterId} />}
      <PolicyInfo policy={policy} />

      {/* The chat pane below mounts with `showHeader={false}`, so the copy of
       * this control in `chat-header` never renders here. Without it the dock —
       * which defaults to collapsed — had no in-page opener on this route at
       * all. */}
      <ArtifactDockToggle className="h-7 w-7" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => setContactOpen(true)}
            aria-label={t("openContact")}
            data-testid="conversation-header-contact"
          >
            <UserRoundIcon className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("openContact")}</TooltipContent>
      </Tooltip>

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

      {/* A2UI callback-bindings inspector — diagnostic surface for triaging
       * "the button didn't route my surface". Desktop-only because the row
       * "test" action drives the live bus runtime. */}
      {parsedAdapterId && desktop && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              onClick={() => setBindingsOpen(true)}
              aria-label={tBindings("openInspector")}
              data-testid="conversation-header-bindings"
            >
              <ListChecksIcon className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tBindings("openInspector")}</TooltipContent>
        </Tooltip>
      )}

      <ConversationOverrideDialog
        open={overrideDialogOpen}
        onOpenChange={setOverrideDialogOpen}
        adapterId={parsedAdapterId}
        conversationKey={conversationKey}
        sessionId={sessionId}
        initialRow={overrideRow ?? null}
      />

      <ContactProfileDrawer
        open={contactOpen}
        onOpenChange={setContactOpen}
        conversationKey={conversationKey}
      />

      {parsedAdapterId && desktop && (
        <CallbackBindingsInspector
          open={bindingsOpen}
          onOpenChange={setBindingsOpen}
          conversationKey={conversationKey}
          adapterId={parsedAdapterId}
        />
      )}
    </header>
  )
}
