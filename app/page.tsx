"use client"

import { AppShellMobile } from "@/components/app-shell-mobile"
import { DiscordShell } from "@/components/desktop/shell"
import { usePlatform } from "@/hooks/use-platform"

export default function Home() {
  const platform = usePlatform()
  return platform === "mobile" ? <AppShellMobile /> : <DiscordShell />
}
