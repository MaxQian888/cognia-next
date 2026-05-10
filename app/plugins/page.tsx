import { Suspense } from "react"
import { PluginPanel } from "@/components/plugins"

// PluginPanel reads `useSearchParams()` for tab state. Next's static export
// pre-renders this page server-side, where useSearchParams() throws unless
// a Suspense boundary lets it bail out to client-side rendering.
export default function PluginsRoutePage() {
  return (
    <div className="h-full w-full min-h-0 flex-1" data-bg-target="chat">
      <Suspense fallback={null}>
        <PluginPanel />
      </Suspense>
    </div>
  )
}
