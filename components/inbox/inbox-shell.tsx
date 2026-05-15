"use client"

/**
 * Three-pane Inbox shell: left sidebar (InboxSidebar), middle conversation
 * list (ConversationList), right detail (children).
 *
 * Uses the shadcn SidebarProvider / Sidebar / SidebarInset primitives so
 * the collapse affordance works consistently with the rest of the app.
 *
 * Responsive behaviour:
 *   - ≥ 1024 px (desktop): sidebar open by default, middle pane w-72.
 *   - 768–1023 px (tablet): sidebar starts collapsed to free space for the
 *     detail pane; the user can still expand it from the standard trigger.
 *     Middle pane uses w-64.
 *   - < 768 px (mobile): out of scope for this pass — three-pane still
 *     renders but layout is not optimised.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar"
import { InboxSidebar } from "./inbox-sidebar"
import { ConversationList } from "./conversation-list"

export type InboxView = "all" | "by-adapter" | "by-platform" | "conversation"

export interface InboxShellProps {
  /** Which inbox view is active — drives sidebar highlight + list filter. */
  view: InboxView
  /** Adapter-scoped view: only this adapter's conversations are shown. */
  adapterId?: string
  /** Platform-scoped view: conversations for all adapters of one platform. */
  platformKind?: string
  /** Conversation view: only this conversation's messages are shown. */
  conversationKey?: string
  /** Right-pane content (typically the ChatSession view). */
  children?: React.ReactNode
}

/**
 * Returns true when the viewport is in the tablet band (768 ≤ w < 1024).
 * Server render and the first client render return false so we don't trigger
 * a hydration mismatch — the effect kicks in after mount.
 */
function useIsTabletViewport(): boolean {
  const [isTablet, setIsTablet] = useState(false)

  useEffect(() => {
    const mql = window.matchMedia("(min-width: 768px) and (max-width: 1023px)")
    const onChange = () => setIsTablet(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isTablet
}

export function InboxShell({
  view,
  adapterId,
  platformKind,
  conversationKey,
  children,
}: InboxShellProps) {
  const t = useTranslations("inbox.shell")
  const isTablet = useIsTabletViewport()

  return (
    <SidebarProvider
      defaultOpen={!isTablet}
      data-bg-target="chat"
      className="flex h-full min-h-0 flex-1 overflow-hidden safe-area-pt safe-area-pb"
      style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
    >
      {/* Left pane — adapter sections + view-mode chips */}
      <InboxSidebar view={view} activeAdapterId={adapterId} activePlatformKind={platformKind} />

      {/* Middle pane — conversation list (responsive width). */}
      <div
        data-testid="inbox-conversation-list-pane"
        className="w-56 md:w-64 lg:w-72 shrink-0 border-r flex flex-col overflow-hidden"
      >
        <ConversationList
          adapterId={adapterId}
          platformKind={platformKind}
          activeConversationKey={conversationKey}
        />
      </div>

      {/* Right pane — conversation detail / children */}
      <SidebarInset
        data-testid="inbox-detail-pane"
        data-bg-target="chat"
        className="flex flex-col flex-1 min-w-0 overflow-hidden"
      >
        {children ?? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {t("selectPrompt")}
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}
