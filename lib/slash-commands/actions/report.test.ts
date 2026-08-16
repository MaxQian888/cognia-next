/** @jest-environment jsdom */

import { useUIStore } from "@/stores/ui"

import { runReportCommand } from "./report"

beforeEach(() => useUIStore.getState().clearPendingReport())

it("raises a chat-surface report request scoped to the active session", async () => {
  await runReportCommand({ activeSessionId: "s1" })
  expect(useUIStore.getState().pendingReportRequest).toEqual({
    context: { surface: "chat", sessionId: "s1" },
    nonce: 1,
  })
})

it("omits the session id when no session is active", async () => {
  await runReportCommand({ activeSessionId: null })
  expect(useUIStore.getState().pendingReportRequest?.context).toEqual({ surface: "chat" })
})
