"use client"

/**
 * Three-pane Inbox shell: left sidebar (InboxSidebar), middle conversation
 * list (ConversationList), right detail (children).
 *
 * Uses the shadcn SidebarProvider / Sidebar / SidebarInset primitives so
 * the collapse affordance works consistently with the rest of the app.
 */

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

export function InboxShell({
  view,
  adapterId,
  platformKind,
  conversationKey,
  children,
}: InboxShellProps) {
  return (
    <SidebarProvider
      defaultOpen
      data-bg-target="chat"
      className="flex h-dvh overflow-hidden safe-area-pt safe-area-pb"
      style={{ "--sidebar-width": "14rem" } as React.CSSProperties}
    >
      {/* Left pane — adapter sections + view-mode chips */}
      <InboxSidebar view={view} activeAdapterId={adapterId} activePlatformKind={platformKind} />

      {/* Middle pane — conversation list */}
      <div
        data-testid="inbox-conversation-list-pane"
        className="w-72 shrink-0 border-r flex flex-col overflow-hidden"
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
            Select a conversation to start
          </div>
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}
