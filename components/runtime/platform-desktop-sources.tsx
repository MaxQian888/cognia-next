/**
 * Desktop companion source providers seam — DEFAULT variant (browser + Tauri).
 *
 * Both providers below are Tauri-only at runtime (`usePlatform() !== "tauri"`
 * and their effect returns immediately) and both render `<>{children}</>`
 * unchanged, so mounting them on the web costs nothing at runtime. What they
 * DO cost is bundle: each statically imports the desktop bridge graph
 * (`lib/sync/desktop-sync-source`, `lib/db/agent-team-projection`,
 * `lib/mcp/*`, `lib/companion/desktop-*-source`, `lib/cli-bridge/*`,
 * `lib/plugin/wasm-bridge`). `platform-desktop-sources.mobile.tsx` drops that
 * graph from the Capacitor bundle, where none of it can ever run.
 *
 * They are wrappers, not siblings, so `next/dynamic` is the wrong tool here —
 * a dynamic wrapper renders its `loading` fallback first and would unmount the
 * whole application subtree for a tick. The build-target variant has no such
 * seam.
 *
 * Web and Tauri share one `out/`, so this variant must keep mounting them.
 */

import { DesktopMessageSourceProvider } from "@/components/providers/desktop-message-source-provider"
import { DesktopSyncSourceProvider } from "@/components/providers/desktop-sync-source-provider"

export function PlatformDesktopSources({ children }: { children: React.ReactNode }) {
  return (
    <DesktopSyncSourceProvider>
      <DesktopMessageSourceProvider>{children}</DesktopMessageSourceProvider>
    </DesktopSyncSourceProvider>
  )
}
