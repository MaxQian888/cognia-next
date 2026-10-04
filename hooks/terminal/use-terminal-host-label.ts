"use client"

import { useTranslations } from "next-intl"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"
import type { TerminalSessionRow } from "@/stores/terminal/terminal-store"

/** Shared host wording for tabs and session details; durable host ids are not registry ids. */
export function useTerminalHostLabel(row: TerminalSessionRow | undefined) {
  const t = useTranslations("terminal.host")
  const activeHostId = useRemoteHostStore((state) => state.activeHostId)
  const registeredLabel = useRemoteHostStore(
    (state) => state.hosts.find((host) => host.id === row?.remoteHost?.id)?.label
  )
  const remote = row?.remoteHost
  const local = !!row && !remote && (row.remoteHost === null || row.origin === "local")
  const label = remote ? (registeredLabel ?? remote.label) : local ? t("thisDesktop") : t("unknown")
  const different = !!row && (remote ? remote.id !== activeHostId : !local || activeHostId !== null)
  return {
    label,
    different,
    description: t(different ? "differentTarget" : "runsOn", { host: label }),
  }
}
