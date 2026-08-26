"use client"

/**
 * Conversation header strip for the Inbox detail pane.
 *
 * Deliberately thin: identity (platform avatar + character chip + name), the
 * one control that says what the next turn will run as (ModeSwitcher), and
 * three trailing affordances — overflow, artifact dock, overrides gear.
 *
 * Everything else lives in `ConversationHeaderOverflow`. This strip used to
 * carry twenty flat siblings, and because `buttonVariants` / `badgeVariants`
 * bake `shrink-0` into their base, none of them compressed — the row ran past
 * the pane, which `ResizablePanel` clips, so the trailing controls became
 * unclickable. `lib/ui/chrome-budget.ts` pins the new count.
 *
 * Height matches `chat-header.tsx` (`h-9`) so the Inbox detail pane and the
 * main chat page present the same seam.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon, Settings2Icon } from "lucide-react"
import { ModeSwitcher } from "./mode-switcher"
import { ContactProfileDrawer } from "./contact-profile-drawer"
import { PlatformBadge } from "./platform-badge"
import { ConversationOverrideDialog } from "./overrides/conversation-override-dialog"
import { CallbackBindingsInspector } from "./debug/callback-bindings-inspector"
import { ConversationHeaderOverflow } from "./conversation-header-overflow"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
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

interface ConversationHeaderProps {
  conversationKey: string
  sessionId: string
  title: string
  platform: PlatformKind
  currentMode: ConnectorMode
  /** The RESOLVED policy; `undefined` while the adapter row is still loading. */
  policy: TriggerPolicy | undefined
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
      className="flex h-9 shrink-0 items-center gap-2 border-b bg-background/80 px-2 backdrop-blur md:px-3"
      data-testid="conversation-header"
    >
      {/* Mobile-only nav cluster: back to the conversation list + open the
       * adapters Sheet. Hidden on md+ where the three-pane shell exposes
       * both surfaces directly. */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7 md:hidden"
        onClick={handleBack}
        aria-label={t("backToList")}
        data-testid="conversation-header-back"
      >
        <ChevronLeftIcon className="size-4" />
      </Button>
      <SidebarTrigger
        className="md:hidden"
        aria-label={t("openSidebar")}
        data-testid="conversation-header-open-sidebar"
      />

      {/* Left: platform + character chip + title */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <PlatformBadge platform={platform} iconOnly />
        {character && (
          <span
            className="flex min-w-0 items-center gap-1.5"
            data-testid="conversation-character-chip"
          >
            <span
              className="flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium"
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
        {/* `font-medium`, matching `chat-header.tsx` — same seam, same weight. */}
        <h2 className="truncate text-sm font-medium">{title}</h2>
      </div>

      {/* The one control that answers "what will the next turn run as" earns
          its place in the strip; every other setting lives behind `⋯`.
          Live ModeSwitcher on desktop, static disabled badge on web. */}
      {desktop ? (
        <ModeSwitcher
          conversationKey={conversationKey}
          sessionId={sessionId}
          currentMode={currentMode}
          onModeChange={onModeChange}
        />
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

      {/* Status, routing, health and tooling — one popover, opened on demand. */}
      <ConversationHeaderOverflow
        conversationKey={conversationKey}
        sessionId={sessionId}
        adapterId={parsedAdapterId}
        policy={policy}
        overrideRow={overrideRow}
        providerOverride={providerOverride}
        modelOverride={modelOverride}
        desktop={desktop}
        onOpenContact={() => setContactOpen(true)}
        onOpenBindings={() => setBindingsOpen(true)}
      />

      {/* The chat pane below mounts with `showHeader={false}`, so the copy of
       * this control in `chat-header` never renders here. Without it the dock —
       * which defaults to collapsed — had no in-page opener on this route at
       * all. That applies doubly on a phone, where the `AppShellMobile` top bar
       * (the other standing opener) isn't mounted either, so the toggle must
       * NOT be breakpoint-gated. */}
      <ArtifactDockToggle className="size-7" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={() => setOverrideDialogOpen(true)}
            aria-label={t("openOverridesAria")}
            data-testid="conversation-header-overrides"
          >
            <Settings2Icon className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{t("openOverrides")}</TooltipContent>
      </Tooltip>

      {/* The dialogs stay mounted here — only their triggers moved into the
          overflow, so opening one still works after the popover closes. */}
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
