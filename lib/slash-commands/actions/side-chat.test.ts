import { dispatchSideChat, openSideChat } from "./side-chat"
import type { SlashContext } from "../builtin"
import { useSideChatRequestStore } from "@/stores/chat/side-chat-request-store"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { toast } from "sonner"

const mockGet = jest.fn()
const mockEnsure = jest.fn()
const mockReveal = jest.fn()
const mockOverride = jest.fn()
let mockOverrides: Record<string, string> = {}
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({ sessions: { get: mockGet } }) }))
jest.mock("@/lib/db/resource-workbench-sessions", () => ({
  createResourceSessionRepository: () => ({}),
}))
jest.mock("@/lib/context-workbench/resource-session", () => ({
  ensureResourceWorkbenchSession: (...args: unknown[]) => mockEnsure(...args),
}))
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => ({
  useArtifactDockLayoutStore: { getState: () => ({ revealSidechat: mockReveal }) },
}))
jest.mock("@/stores/context-workbench/context-workbench-store", () => ({
  useContextWorkbenchStore: {
    getState: () => ({ sessionOverrides: mockOverrides, setSessionOverride: mockOverride }),
  },
}))
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async () => (key: string) => key,
}))
jest.mock("@/lib/platform/detect", () => ({ isNativeMobile: () => false }))
jest.mock("sonner", () => ({ toast: { info: jest.fn(), error: jest.fn() } }))

const ctx = (extra: Partial<SlashContext> = {}) =>
  ({
    activeSessionId: "main",
    args: "question",
    chatStatus: "streaming",
    ...extra,
  }) as SlashContext

beforeEach(() => {
  jest.clearAllMocks()
  mockOverrides = {}
  mockGet.mockResolvedValue(undefined)
  mockEnsure.mockResolvedValue({ id: "primary", kind: "resource-workbench" })
  useSideChatRequestStore.setState({ pending: {} })
  useComposerIntentStore.setState({ pendingBySession: {} })
})

it.each(["streaming", "awaiting_approval"] as const)(
  "opens and stages during %s without a main send",
  async (chatStatus) => {
    await dispatchSideChat(ctx({ chatStatus }))
    expect(mockEnsure).toHaveBeenCalledWith(
      { kind: "session", sessionId: "main" },
      expect.any(String),
      {}
    )
    expect(useSideChatRequestStore.getState().pending.primary[0].question).toBe("question")
    expect(mockReveal).toHaveBeenCalledTimes(1)
  }
)

it("uses the switcher's override and only focuses when there is no question", async () => {
  const { getContextResourceKey } = await import("@/types/context-workbench")
  mockOverrides[
    getContextResourceKey({ kind: "session", sessionId: "main", capabilities: ["ai"] })
  ] = "chosen"
  mockGet.mockResolvedValue({ id: "chosen", kind: "resource-workbench" })
  await openSideChat("main")
  expect(mockEnsure).not.toHaveBeenCalled()
  expect(useSideChatRequestStore.getState().pending).toEqual({})
  expect(useComposerIntentStore.getState().pendingBySession.chosen.prompt).toBeNull()
})

it("falls back through ensure when the selected aside no longer exists", async () => {
  const { getContextResourceKey } = await import("@/types/context-workbench")
  const key = getContextResourceKey({ kind: "session", sessionId: "main", capabilities: ["ai"] })
  mockOverrides[key] = "deleted"
  await openSideChat("main", "question")
  expect(mockOverride).toHaveBeenCalledWith(key, null)
  expect(mockEnsure).toHaveBeenCalled()
})

it.each([
  [{ isMobile: true }, "desktopOnly"],
  [{ activeSessionId: null }, "needSession"],
] as const)("explains unavailable entry points", async (overrides, message) => {
  await dispatchSideChat(ctx(overrides))
  expect(toast.info).toHaveBeenCalledWith(message)
  expect(mockReveal).not.toHaveBeenCalled()
})

it("does not nest asides", async () => {
  await dispatchSideChat(ctx({ isAside: true }))
  expect(mockEnsure).not.toHaveBeenCalled()
  expect(mockReveal).not.toHaveBeenCalled()
})

it("reports an opening failure", async () => {
  mockEnsure.mockRejectedValueOnce(new Error("database unavailable"))
  await dispatchSideChat(ctx())
  expect(toast.error).toHaveBeenCalledWith("openError")
  expect(mockReveal).not.toHaveBeenCalled()
})
