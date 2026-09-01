"use client"

import { SourceControlMobileBody } from "@/components/mobile/source-control/source-control-mobile-body"
import { SourceControlPanel } from "@/components/source-control/source-control-panel"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

/**
 * Dedicated full-page Source Control route, reached from the guild-rail
 * "Source Control" entry.
 *
 * Thin by design: the route owns nothing but which body to mount. The desktop
 * panel carries its own chrome and a resizable two-pane split, which is not a
 * layout at 375px but two unusable columns, so the compact branch inverts it:
 * the change list is the page and the diff arrives as a drawer. Both read the
 * same `useGitStore` and drive the same `useGitActions`.
 */
export default function SourceControlPage() {
  const compact = useCompactLayout()
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {compact ? <SourceControlMobileBody /> : <SourceControlPanel />}
    </div>
  )
}
