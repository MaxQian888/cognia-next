"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  canReadHostSkills,
  canWriteHostSkills,
  pullAllFromNative,
  pushAllToNative,
  pushOneToNative,
  type SyncResult,
} from "@/lib/skills/sync"

export interface UseSkillSync {
  busy: boolean
  push: () => Promise<void>
  pull: () => Promise<void>
  pushOne: (skillId: string) => Promise<void>
}

export function useSkillSync(): UseSkillSync {
  const [busy, setBusy] = useState(false)
  const t = useTranslations("skills.sync")

  const push = async () => {
    if (!canWriteHostSkills()) {
      toast.error(t("unavailableWrite"))
      return
    }
    setBusy(true)
    try {
      const result = await pushAllToNative()
      summariseSync(result, "push", t)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pull = async () => {
    if (!canReadHostSkills()) {
      toast.error(t("unavailableRead"))
      return
    }
    setBusy(true)
    try {
      const result = await pullAllFromNative()
      summariseSync(result, "pull", t)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pushOne = async (skillId: string) => {
    if (!canWriteHostSkills()) {
      toast.error(t("unavailableWrite"))
      return
    }
    setBusy(true)
    try {
      const result = await pushOneToNative(skillId)
      summariseSync(result, "push", t)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return { busy, push, pull, pushOne }
}

function summariseSync(
  result: SyncResult,
  kind: "push" | "pull",
  t: ReturnType<typeof useTranslations>
) {
  const parts: string[] = []
  if (kind === "push" && result.pushed > 0) parts.push(t("pushed", { count: result.pushed }))
  if (kind === "pull" && result.pulled > 0) parts.push(t("pulled", { count: result.pulled }))
  if (result.skipped > 0) parts.push(t("skipped", { count: result.skipped }))
  if (result.errors.length > 0) parts.push(t("errored", { count: result.errors.length }))
  if (result.errors.length > 0) {
    toast.warning(parts.join(", ") || t("noChanges"))
  } else if (parts.length === 0) {
    toast.info(t("noChanges"))
  } else {
    toast.success(parts.join(", "))
  }
}
