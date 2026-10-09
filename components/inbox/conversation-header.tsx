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
 * Height matches `chat-header.tsx` (`h-9`) so every platform conversation
 * header presents the same seam as the main chat page.
 *
 * Where it renders: IM sessions open in the shared chat workspace (the old
 * `/inbox/c` conversation pane redirects there), and that workspace mounts
 * this header in `controlsOnly` mode through `PlatformConversationHeader`.
 * The full strip (identity + back + sidebar trigger) is the standalone form.
 * The Inbox's own detail pane is the triage preview now, which draws the same
 * controls from `conversation-control-groups.tsx` and
 * `conversation-mode-control.tsx` rather than mounting this header.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { ChevronLeftIcon, Settings2Icon } from "lucide-react"
import { ContactProfileDrawer } from "./contact-profile-drawer"
import { PlatformBadge } from "./platform-badge"
import { ThreadMembershipChip } from "./thread-membership-chip"
import { ConversationOverrideDialog } from "./overrides/conversation-override-dialog"
import { CallbackBindingsInspector } from "./debug/callback-bindings-inspector"
import { ConversationHeaderOverflow } from "./conversation-header-overflow"
import { useConversationOverride } from "@/hooks/connectors/use-conversation-overrides"
import { Button } from "@/components/ui/button"
import { ArtifactDockToggle } from "@/components/artifacts/artifact-dock-toggle"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isTauri } from "@/lib/tauri"
import { useCharacter } from "@/lib/data-hooks/context"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import type { ImModePresetId } from "@/lib/connectors/composition/im-mode-presets"
import { ConversationModeControl } from "./conversation-mode-control"
import { parseConversationKey } from "@/types/connectors/event"
import type { TriggerPolicy } from "@/types/connectors/policy"
import type { PlatformKind } from "@/types/connectors/platform-kind"

interface ConversationHeaderProps {
  conversationKey: string
  sessionId: string
  title: string
  platform: PlatformKind
  /** The RESOLVED policy; `undefined` while the adapter row is still loading. */
  policy: TriggerPolicy | undefined
  characterId?: string
  /** Current ConversationOverrideRow.providerOverride, if set. */
  providerOverride?: string
  /** Current ConversationOverrideRow.modelOverride, if set. */
  modelOverride?: string
  /** Fires after a successful behaviour write, with the preset that landed. */
  onModeChange?: (preset: ImModePresetId) => void
  /** Reuse platform controls inside the common chat header. */
  controlsOnly?: boolean
}

export function ConversationHeader({
  conversationKey,
  sessionId,
  title,
  platform,
  policy,
  characterId,
  providerOverride,
  modelOverride,
  onModeChange,
  controlsOnly = false,
}: ConversationHeaderProps) {
  const t = useTranslations("inbox.conversationHeader")
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

  const Container = controlsOnly ? "div" : "header"
  return (
    <Container
      className={
        controlsOnly
          ? "flex shrink-0 items-center gap-1"
          : "flex h-9 shrink-0 items-center gap-2 border-b bg-background/80 px-2 backdrop-blur md:px-3"
      }
      data-testid="conversation-header"
    >
      {!controlsOnly && (
        <>
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
            <ThreadMembershipChip conversationKey={conversationKey} className="shrink-0" />
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
        </>
      )}

      {/* The one control that answers "what will the next turn run as" earns
          its place in the strip; every other setting lives behind `⋯`.
          Live ModeSwitcher wherever the write can be routed, static disabled
          badge where it cannot. */}
      <ConversationModeControl
        conversationKey={conversationKey}
        sessionId={sessionId}
        adapterId={parsedAdapterId}
        overrideRow={overrideRow}
        onOpenAdvanced={() => setOverrideDialogOpen(true)}
        onModeChange={onModeChange}
      />

      {/* Status, routing, health and tooling — one popover, opened on demand. */}
      <ConversationHeaderOverflow
        conversationKey={conversationKey}
        sessionId={sessionId}
        adapterId={parsedAdapterId}
        policy={policy}
        overrideRow={overrideRow}
        // The shared chat header passes neither prop (it never had the row),
        // which showed the switcher as "default" on a conversation pinned to a
        // model. The live row is the fallback, and the source of truth.
        providerOverride={providerOverride ?? overrideRow?.providerOverride}
        modelOverride={modelOverride ?? overrideRow?.modelOverride}
        desktop={desktop}
        hideOpenInChat={controlsOnly}
        onOpenContact={() => setContactOpen(true)}
        onOpenBindings={() => setBindingsOpen(true)}
      />

      {/* The chat pane below mounts with `showHeader={false}`, so the copy of
       * this control in `chat-header` never renders here. Without it the dock —
       * which defaults to collapsed — had no in-page opener on this route at
       * all. That applies doubly on a phone, where the `AppShellMobile` top bar
       * (the other standing opener) isn't mounted either, so the toggle must
       * NOT be breakpoint-gated. */}
      {!controlsOnly && <ArtifactDockToggle className="size-7" />}

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
    </Container>
  )
}
