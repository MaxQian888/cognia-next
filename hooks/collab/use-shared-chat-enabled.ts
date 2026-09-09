"use client"

/**
 * Whether shared conversations are available to this runtime, live.
 *
 * # Why a hook and not a bare call
 *
 * `isSharedChatClientEnabled()` used to be a build constant, so reading it in
 * a render body was fine. Now that a settings switch can flip it, a component
 * that reads it once keeps showing the sharing controls until the next reload,
 * which is the worst of both answers: the switch says off and the header still
 * offers to share.
 *
 * # Why the first render always says the build's answer
 *
 * The preference lives in `localStorage`, and this app is a static export. A
 * lazy `useState` initializer reading storage would render one value during
 * the prerender and another on the client, so the first paint deliberately
 * reports what the build alone allows and the stored choice is applied in an
 * effect. Same shape the collaboration settings card uses for its own read.
 */

import { useEffect, useState } from "react"

import {
  isSharedChatBuildEnabled,
  isSharedChatClientEnabled,
  subscribeSharedChatPreference,
} from "@/lib/collab/shared-chat-feature"

export function useSharedChatEnabled(): boolean {
  const [enabled, setEnabled] = useState(isSharedChatBuildEnabled)

  useEffect(() => {
    const sync = () => setEnabled(isSharedChatClientEnabled())
    sync()
    return subscribeSharedChatPreference(sync)
  }, [])

  return enabled
}
