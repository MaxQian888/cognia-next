import { transport } from "@/lib/tauri/transport-instance"

import {
  createCodexAppTask,
  getCodexAppInventory,
  getCodexAppRuntimeStatus,
  interruptCodexAppTask,
  listCodexAppTasks,
  openCodexAppTask,
  readCodexAppTask,
  sendCodexAppTask,
} from "./codex-app-control"

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: jest.fn() },
}))

const call = transport.call as jest.Mock

beforeEach(() => {
  call.mockReset().mockResolvedValue({})
})

test("Codex App controls use the shared transport command surface", async () => {
  await getCodexAppRuntimeStatus()
  await listCodexAppTasks({ cwd: "/workspace", searchTerm: "browser", limit: 20 })
  await readCodexAppTask("thread-1", false)
  await createCodexAppTask({
    cwd: "/workspace",
    input: [{ type: "text", text: "Use Browser" }],
    browserUrl: "https://example.com",
  })
  await sendCodexAppTask({
    threadId: "thread-1",
    input: [
      { type: "text", text: "Use Browser" },
      { type: "mention", name: "Browser", path: "/plugins/browser" },
      { type: "localImage", path: "/workspace/image.png" },
    ],
    contextLabel: "Browser",
  })
  await interruptCodexAppTask("thread-1", "turn-1")
  await openCodexAppTask("thread-1")
  await getCodexAppInventory({ cwd: "/workspace", forceReload: true, threadId: "thread-1" })

  expect(call.mock.calls).toEqual([
    ["codex_app_runtime_status"],
    ["codex_app_task_list", { request: { cwd: "/workspace", searchTerm: "browser", limit: 20 } }],
    ["codex_app_task_read", { request: { threadId: "thread-1", includeTurns: false } }],
    [
      "codex_app_task_create",
      {
        request: {
          cwd: "/workspace",
          input: [{ type: "text", text: "Use Browser" }],
          browserUrl: "https://example.com",
        },
      },
    ],
    [
      "codex_app_task_send",
      {
        request: {
          threadId: "thread-1",
          input: [
            { type: "text", text: "Use Browser" },
            { type: "mention", name: "Browser", path: "/plugins/browser" },
            { type: "localImage", path: "/workspace/image.png" },
          ],
          contextLabel: "Browser",
        },
      },
    ],
    ["codex_app_task_interrupt", { request: { threadId: "thread-1", turnId: "turn-1" } }],
    ["codex_app_task_open", { threadId: "thread-1" }],
    [
      "codex_app_inventory",
      { request: { cwd: "/workspace", forceReload: true, threadId: "thread-1" } },
    ],
  ])
})
