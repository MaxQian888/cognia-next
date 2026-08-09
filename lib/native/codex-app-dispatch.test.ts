import { invoke } from "@tauri-apps/api/core"

import { dispatchConversationToCodexApp } from "./codex-app-dispatch"

const mockedInvoke = invoke as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
})

test("dispatchConversationToCodexApp forwards the typed snapshot to Tauri", async () => {
  const request = {
    title: "Investigate auth",
    cwd: "/repo",
    messages: [
      { role: "user" as const, content: "Why does this fail?", timestampMs: 1_723_000_000_000 },
      { role: "assistant" as const, content: "The token expired." },
    ],
  }
  mockedInvoke.mockResolvedValueOnce({
    threadId: "019abc",
    deepLink: "codex://threads/019abc",
  })

  await expect(dispatchConversationToCodexApp(request)).resolves.toEqual({
    threadId: "019abc",
    deepLink: "codex://threads/019abc",
  })
  expect(mockedInvoke).toHaveBeenCalledWith("codex_app_dispatch_conversation", { request })
})
