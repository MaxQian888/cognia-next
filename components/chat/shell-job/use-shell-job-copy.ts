"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"

import type { ShellJobCopy } from "@/lib/shell-intelligence/shell-job"

/**
 * The translated phrases a `!` job's transcript lines are built from. Shared
 * by the composer, which starts the run, and the card, which re-attaches one
 * after a reload — so both write the same words for the same outcome.
 */
export function useShellJobCopy(): ShellJobCopy {
  const t = useTranslations("chat.composer.shell.job")
  return useMemo<ShellJobCopy>(
    () => ({
      header: (command, status) => t("header", { cmd: command, status }),
      statusExit: (code) => t("status.exit", { code: String(code) }),
      statusKilled: t("status.killed"),
      statusInterrupted: t("status.interrupted"),
      statusFailed: t("status.failed"),
      noOutput: t("noOutput"),
      truncated: t("truncated"),
      movedToBackground: (command) => t("movedToBackground", { cmd: command }),
      lost: (command, error) => t("lost", { cmd: command, error }),
    }),
    [t]
  )
}
