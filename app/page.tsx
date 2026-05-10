"use client"

import { AppShellMobile } from "@/components/app-shell-mobile"
import { DesktopChatWorkspace } from "@/components/desktop/desktop-chat-workspace"
import { usePlatform } from "@/hooks/use-platform"

export default function Home() {
  const platform = usePlatform()
  return platform === "mobile" ? <AppShellMobile /> : <DesktopChatWorkspace />
}
