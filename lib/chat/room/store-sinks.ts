/**
 * `RoomRunnerSinks` over the zustand stores.
 *
 * The desktop renderer uses this directly (the same three stores the hook
 * always wrote), and the headless brain wraps it (`lib/headless/runtimes/
 * room-runner.ts`) to add host-event fan-out. Zustand stores are plain
 * modules, so the same object works in Node: `useUIStore.getState()` is a
 * function call, not a hook, and nothing here subscribes.
 *
 * Approvals for a room with no open pane follow the direct-chat rule from
 * `hooks/chat/claude-chat-events.ts`: a remote device holding a CONTROL
 * lease on the room decides, a backstop denies if it never answers, and
 * anything else is denied outright. The room used to auto-deny without
 * consulting the lease, which is why a phone could never approve a team
 * member's tool call.
 */

import { useChatStore } from "@/stores/chat"
import { lastTypedAt } from "@/stores/chat/composer-typing-store"
import { useSettingsStore } from "@/stores/settings"
import { useUIStore } from "@/stores/ui"
import {
  appendSteerMessage,
  isSessionOpen,
  maybeDrainSteer,
  sessionStatusOf,
  steerArmed,
} from "@/hooks/chat/steer-runtime"
import {
  armApprovalBackstop,
  clearApprovalBackstops,
  isSessionAttached,
} from "@/lib/companion/remote-attach-registry"
import { notifyRemoteNeedsInput } from "@/lib/companion/needs-input-notifier"
import type { RoomRunnerSinks } from "./runner-deps"

export function createStoreRoomSinks(): RoomRunnerSinks {
  return {
    status: {
      get: (sessionId) => sessionStatusOf(sessionId),
      set: (sessionId, status) => useChatStore.getState().setSessionStatus(sessionId, status),
      setError: (sessionId, error) => useChatStore.getState().setSessionError(sessionId, error),
    },
    diagnostic: (sessionId, diagnostic) =>
      useChatStore.getState().setSessionDiagnostic(sessionId, diagnostic),
    messages: {
      read: (sessionId) => useChatStore.getState().sessions[sessionId]?.messages,
      commit: (sessionId, messages) =>
        useChatStore.getState().replaceSessionMessages(sessionId, messages),
      setActiveBranch: (sessionId, groupId, messageId) =>
        useChatStore.getState().setSessionActiveBranch(sessionId, groupId, messageId),
      isOpen: (sessionId) => isSessionOpen(sessionId),
    },
    steer: {
      queue: (sessionId) => useChatStore.getState().sessions[sessionId]?.steerQueue ?? [],
      enqueue: (sessionId, entry) => useChatStore.getState().enqueueSteer(sessionId, entry),
      clear: (sessionId) => useChatStore.getState().clearSteerQueue(sessionId),
      appendMessage: (sessionId, message) => appendSteerMessage(sessionId, message),
      drain: (sessionId, replay) => maybeDrainSteer(sessionId, replay, true),
      armed: steerArmed,
    },
    members: {
      setStatus: (sessionId, characterId, status) =>
        useUIStore.getState().setMemberStatus(sessionId, characterId, status),
      setActivity: (sessionId, characterId, activity) =>
        useUIStore.getState().setMemberActivity(sessionId, characterId, activity),
      clearFor: (sessionId) => useUIStore.getState().clearMemberStatusFor(sessionId),
      requestStop: (sessionId, characterId) =>
        useUIStore.getState().requestStopMember(sessionId, characterId),
      isStopRequested: (sessionId, characterId) =>
        useUIStore.getState().isStopRequested(sessionId, characterId),
      clearStopRequest: (sessionId, characterId) =>
        useUIStore.getState().clearStopRequest(sessionId, characterId),
      clearStopRequestsFor: (sessionId) => useUIStore.getState().clearStopRequestsFor(sessionId),
    },
    approvals: {
      push: (approval) => useChatStore.getState().pushApproval(approval),
      clear: (requestId) => useChatStore.getState().clearApproval(requestId),
      routeRemote: (roomId, evt, deny) => {
        if (!isSessionAttached(roomId)) return false
        // The sidecar's canUseTool has no timeout of its own, so arm a backstop
        // deny that fires only if the remote never answers. The member's next
        // event cancels it (`onEvent`).
        armApprovalBackstop(evt.sessionId, evt.requestId, () => {
          void deny("auto-denied: remote approval timed out").catch((err) =>
            console.error("remote backstop deny failed", err)
          )
        })
        // Ids only. The notifier resolves which attached devices to wake and
        // never puts the tool name on a push. Targets are attached to the
        // room, the decision is answered on the member sub-session.
        void notifyRemoteNeedsInput({ sessionId: roomId, requestId: evt.requestId }).catch(
          () => undefined
        )
        return true
      },
      onEvent: (subSessionId) => clearApprovalBackstops(subSessionId),
    },
    settings: {
      read: () => useSettingsStore.getState().settings ?? undefined,
      alwaysAllowTools: () => useSettingsStore.getState().settings?.alwaysAllowTools ?? [],
      toggleAlwaysAllow: (toolName, on) =>
        useSettingsStore.getState().toggleAlwaysAllow(toolName, on),
    },
    referencedPaths: () =>
      useChatStore
        .getState()
        .referencedPaths.map((r) => ({ absolute: r.absolute, isDir: r.isDir })),
    human: {
      lastTypedAt: (sessionId) => lastTypedAt(sessionId),
    },
  }
}
