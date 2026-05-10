/**
 * /inbox layout.
 *
 * Bare wrapper — the InboxShell component (Task 48) is rendered inside each
 * child route page so each page can pass view/scope props. This layout
 * only provides the min-h-screen container.
 *
 * Also mounts a client-only `<InboxVisitTracker />` that bumps
 * `settings.lastInboxViewedAt` so the mobile Tab Bar's Chat-tab unread
 * badge clears when the user opens any /inbox/* route.
 */
import { InboxVisitTracker } from "@/components/mobile/inbox-visit-tracker"

export default function InboxLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <InboxVisitTracker />
      {children}
    </div>
  )
}
