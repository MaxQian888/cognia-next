/**
 * /inbox layout.
 *
 * Bare wrapper — the InboxShell component is rendered inside each
 * child route page so each page can pass view/scope props. This layout
 * only fills the DesktopAppShell content slot.
 *
 * Also mounts a client-only `<InboxVisitTracker />` that bumps
 * `settings.lastInboxViewedAt` so the mobile Tab Bar's Chat-tab unread
 * badge clears when the user opens any /inbox/* route.
 *
 * Wraps children in an `InboxErrorBoundary` so a Dexie read failure or
 * unhandled render error inside the Inbox subtree surfaces the v49
 * StateCard.Error fallback instead of blanking the page.
 */
import { InboxVisitTracker } from "@/components/mobile/inbox-visit-tracker"
import { InboxErrorBoundary } from "@/components/inbox/inbox-error-boundary"

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full min-h-0 flex-col">
      <InboxVisitTracker />
      <InboxErrorBoundary>{children}</InboxErrorBoundary>
    </div>
  )
}
