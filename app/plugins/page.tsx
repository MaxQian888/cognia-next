"use client"

import { Suspense } from "react"

import { PluginsMobileBody } from "@/components/mobile/plugins/plugins-mobile-body"
import { PluginPanel } from "@/components/plugins"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

/**
 * `/plugins`, the plugin workspace.
 *
 * Thin by design: the route owns nothing but which body to mount. The compact
 * branch is not a smaller workspace but an inverted one. On a phone the plugin
 * list IS the page and the detail arrives as a drawer, where
 * `FeaturePageShell`'s mobile branch would have left the detail behind an
 * uncontrolled Sheet trigger that a row tap does not open.
 *
 * `PluginPanel` reads `useSearchParams()` for its `?section=` / `?sub=` /
 * `?gov=` / `?subtab=` deep links. Next's static export pre-renders this page
 * server-side, where that hook throws unless a Suspense boundary lets it bail
 * out to client-side rendering.
 */
export default function PluginsRoutePage() {
  const compact = useCompactLayout()
  return (
    <div className="h-full min-h-0 w-full flex-1">
      <Suspense fallback={null}>{compact ? <PluginsMobileBody /> : <PluginPanel />}</Suspense>
    </div>
  )
}
