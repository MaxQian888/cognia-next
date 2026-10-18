"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { launchRemoteDesktopBinding } from "@/lib/remote-desktop/host-client"
import {
  openLaunched,
  remoteDesktopClientKind,
  type LaunchDeps,
  type RemoteDesktopClientKind,
} from "@/lib/remote-desktop/launch"
import type {
  RemoteDesktopBinding,
  RemoteDesktopHostRef,
  RemoteDesktopTarget,
} from "@/lib/remote-desktop/types"
import { remoteDesktopViewerHref } from "@/lib/remote-desktop/viewer-href"

/** What opening did: went to the viewer page, opened a console, asked an app. */
export type RemoteDesktopLaunchOutcome = "viewer" | "console" | "app"

export interface RemoteDesktopLaunchDeps extends LaunchDeps {
  launch?: typeof launchRemoteDesktopBinding
  navigate?: (href: string) => void
}

/** A binding the client opens itself: a web console or an external app. */
export function isLaunchable(binding: RemoteDesktopBinding): boolean {
  return binding.access === "web-console" || binding.access === "external-app"
}

/**
 * Whether this caller may open the binding. A Host leaves the console link
 * and the app's peer out of the list for a caller that may only view,
 * because opening them is control.
 */
export function canLaunch(binding: RemoteDesktopBinding): boolean {
  if (binding.access === "web-console") return Boolean(binding.console?.url)
  if (binding.access === "external-app") return Boolean(binding.launch?.peerId)
  return false
}

/**
 * Open web console and external-app bindings (ADR-0234 Phase 5). On the
 * desktop app a console goes to the viewer page, which embeds it; everywhere
 * else the Host is asked where to go and the console or app opens directly.
 * Refusals are thrown as `RemoteDesktopError`s for the caller to show.
 */
export function useRemoteDesktopLaunch(
  host: RemoteDesktopHostRef,
  deps: RemoteDesktopLaunchDeps = {}
) {
  const router = useRouter()
  const [pending, setPending] = useState<string | null>(null)
  const { launch = launchRemoteDesktopBinding, navigate, ...openDeps } = deps

  const open = async (
    target: RemoteDesktopTarget,
    binding: RemoteDesktopBinding
  ): Promise<RemoteDesktopLaunchOutcome> => {
    const kind: RemoteDesktopClientKind = openDeps.kind ?? remoteDesktopClientKind()
    if (binding.access === "web-console" && kind === "desktop") {
      const href = remoteDesktopViewerHref({
        host,
        targetId: target.id,
        bindingId: binding.id,
        mode: "control",
      })
      ;(navigate ?? router.push)(href)
      return "viewer"
    }
    setPending(binding.id)
    try {
      const launched = await launch(host, { targetId: target.id, bindingId: binding.id })
      await openLaunched(launched, { ...openDeps, kind })
      return launched.kind === "external-app" ? "app" : "console"
    } finally {
      setPending(null)
    }
  }

  return { open, pending }
}
