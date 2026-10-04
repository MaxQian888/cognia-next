"use client"

import dynamic from "next/dynamic"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"

// Platform shells are mutually exclusive at runtime but static imports made
// Turbopack compile both multi-thousand-module graphs for `/`. Keep the
// hydration snapshot lightweight, then request only the active shell.
const AppShellMobile = dynamic(
  () => import("@/components/app-shell-mobile").then((module) => module.AppShellMobile),
  { ssr: false }
)
const DesktopChatWorkspace = dynamic(
  () =>
    import("@/components/desktop/desktop-chat-workspace").then(
      (module) => module.DesktopChatWorkspace
    ),
  { ssr: false }
)
export default function RouteBody() {
  const compact = useCompactLayout()
  return compact ? <AppShellMobile /> : <DesktopChatWorkspace />
}
