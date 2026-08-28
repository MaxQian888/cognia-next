"use client"

/**
 * Desktop entry point for the issue tracker: runs the host-neutral
 * `bootIssueTracker` (`lib/issues/boot.ts`) on account unlock, and installs the
 * one effect that genuinely needs React — the `issue.open` notification
 * command, whose body is an App Router `router.push`.
 *
 * Without this the board renders empty forever — `registerLocalIssueSource`
 * exists and is tested, but a registry nobody registers into is the repo's
 * single most recurrent defect class (built, correct, and unreachable at
 * runtime). The `wiring-auditor` skill exists because of it, and the same
 * defect recurred one level up: the boot body itself lived here, so it ran only
 * in the WebView and a cloud install drove no issue runs at all. The brain now
 * boots it through `lib/headless/runtimes/issue-tracker.ts` (ADR-0059).
 */

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { loggers } from "@cognia/logging"

import { installIssueNotificationCommands, type IssueNotifyTranslate } from "@/lib/issues/notify"
import { useAccountStore } from "@/stores/account/account-store"
import { installCollabRefreshScheduler } from "@/lib/collab/refresh-scheduler"

// The boot body lives in `lib/issues/boot.ts` so the headless brain can run the
// same code without pulling React and `next/*` into its bundle
// (lib/headless/runtimes/issue-tracker.ts). Re-exported here because this was
// the original home and callers/tests still import it from this path.
export { bootIssueTracker, type BootIssueTrackerOptions } from "@/lib/issues/boot"
import { bootIssueTracker } from "@/lib/issues/boot"

const log = loggers.shell

export function IssueTrackerInitializer() {
  const unlockedAccountId = useAccountStore((state) => state.unlockedAccountId)
  const startedFor = useRef<string | null>(null)
  const router = useRouter()
  const t = useTranslations("issues")
  // Notification text is rendered at emit time; hand the watcher the latest
  // translator without re-booting on every locale/render change. The ref is
  // written in an effect (never during render), so React's ref rules hold.
  const translateRef = useRef<IssueNotifyTranslate>(t)
  useEffect(() => {
    translateRef.current = t
  }, [t])

  useEffect(() => {
    if (!unlockedAccountId) return
    if (startedFor.current === unlockedAccountId) return
    startedFor.current = unlockedAccountId

    void bootIssueTracker({
      translate: (key, values) => translateRef.current(key, values),
    }).catch((error) => {
      // Never block boot on the tracker: a failed seed leaves an empty label
      // catalogue, which is recoverable, while a thrown effect is not.
      log.warn("issue-tracker: boot failed", { error: String(error) })
    })
  }, [unlockedAccountId])

  useEffect(() => {
    if (!unlockedAccountId) return
    return installCollabRefreshScheduler(unlockedAccountId)
  }, [unlockedAccountId])

  // The `issue.open` notification action needs the App Router, which only
  // React can hand out — same arrangement as the diagnostics commands.
  useEffect(
    () => installIssueNotificationCommands({ navigate: (path) => router.push(path) }),
    [router]
  )

  return null
}
