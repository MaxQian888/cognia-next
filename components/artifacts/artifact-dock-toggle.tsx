"use client"

/**
 * Show/hide the right-hand artifact dock.
 *
 * Shared rather than duplicated because the dock defaults to collapsed: any
 * surface that mounts `ArtifactWorkspaceDock` but omits this control has no
 * in-page way to open the right rail at all. `/inbox/c` was in exactly that
 * position — it renders the chat pane with `showHeader={false}`, so the copy of
 * this button living in `chat-header` never mounted, leaving only ⌘/Ctrl+J and
 * the Tauri title bar (which does not exist in the web shell).
 *
 * Drives the one `dockCollapsed` field that ⌘J and the title-bar layout
 * controls also drive.
 */

import { useTranslations } from "next-intl"
import { PanelRightCloseIcon, PanelRightOpenIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

export function ArtifactDockToggle({ className }: { className?: string }) {
  const t = useTranslations("chat.header")
  const dockCollapsed = useArtifactDockLayoutStore((s) => s.dockCollapsed)
  const toggleDock = useArtifactDockLayoutStore((s) => s.toggleDock)
  // A new artifact arrived while the dock was dismissed — surface it as an
  // unread dot instead of force-expanding the panel.
  const unreadArtifact = useArtifactDockLayoutStore((s) => s.unreadArtifact)
  const showUnread = dockCollapsed && unreadArtifact
  const label = showUnread
    ? t("unreadArtifacts")
    : dockCollapsed
      ? t("showArtifacts")
      : t("hideArtifacts")

  return (
    <Button
      variant="ghost"
      size="icon"
      // Visibility belongs to the caller. Hiding below `md` here made the
      // unread dot unreachable on a phone — and the mobile shell renders the
      // chat with `showHeader={false}`, so the one host that did mount this
      // never existed there at all, leaving no way back once the Sheet was
      // closed. Desktop hosts opt into the breakpoint themselves.
      className={cn("relative size-8 shrink-0", className)}
      onClick={toggleDock}
      aria-label={label}
      aria-pressed={!dockCollapsed}
      title={label}
      data-testid="chat-artifact-dock-toggle"
    >
      {dockCollapsed ? (
        <PanelRightOpenIcon className="size-4" />
      ) : (
        <PanelRightCloseIcon className="size-4" />
      )}
      {showUnread && (
        <span
          aria-hidden
          data-testid="chat-artifact-dock-unread"
          className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
        />
      )}
    </Button>
  )
}
