"use client"

/**
 * The composer's view of whether this conversation may send an original video.
 *
 * Reads the model the way `ModelPicker` labels it — the conversation's own pick,
 * then the app defaults — and the conversation facts that close the gate. It is
 * a prediction: the controller re-checks the route `resolveSendOptions` actually
 * resolves (`lib/chat/attachments/video/route-guard.ts`), so a wrong guess here
 * costs a toast and a storyboard, never a rejected request.
 */

import { useMemo } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import {
  nativeVideoRouteVerdict,
  type NativeVideoVerdict,
  type VideoRouteFacts,
} from "@/lib/chat/attachments/video/delivery-gate"
import { videoRouteFacts } from "@/lib/chat/attachments/video/route-facts"
import { isStandaloneChatMode } from "@/lib/runtime/standalone-mode"
import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useSettingsStore } from "@/stores/settings"

export interface ComposerVideoRoute {
  facts: VideoRouteFacts
  verdict: NativeVideoVerdict
}

export function useComposerVideoRoute(session: ChatSession | null | undefined): ComposerVideoRoute {
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)
  const autoRouting = useSettingsStore((s) => s.settings?.autoRouting?.enabled === true)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  const runtimeRef = useRuntimeRefForSession(session?.id)

  const providerId = session?.providerOverride ?? defaultProvider ?? "anthropic"
  const modelId = session?.model ?? defaultModel ?? ANTHROPIC_DEFAULT_MODEL
  const externalAgent = runtimeRef.kind !== "builtin"
  const platformBound = Boolean(session?.platformBinding)
  const teamRoom = session?.kind === "team"
  const sharedCollaboration = Boolean(session?.collaboration)

  return useMemo(() => {
    const facts = videoRouteFacts({
      providerId,
      modelId,
      providerSettings,
      customProviders,
      platformBound,
      teamRoom,
      sharedCollaboration,
      externalAgent,
      standalone: isStandaloneChatMode(),
      autoRouting,
    })
    return { facts, verdict: nativeVideoRouteVerdict(facts) }
  }, [
    autoRouting,
    customProviders,
    externalAgent,
    modelId,
    platformBound,
    providerId,
    providerSettings,
    sharedCollaboration,
    teamRoom,
  ])
}
