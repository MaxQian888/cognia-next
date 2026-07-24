/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"

const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/lark/shortcut",
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/connectors/lark-web/intent-client", () => ({
  parseShortcutLaunch: jest.fn(() => ({ triggerId: "t1", adapterId: "lk-1" })),
  runLarkEntryFlow: jest.fn(),
}))

jest.mock("@/lib/connectors/lark-web/jssdk", () => ({
  loadLarkJsSdkScript: jest.fn(async () => undefined),
  configureLarkJsSdk: jest.fn(async () => undefined),
  getLarkTriggerDetail: jest.fn(async () => ({})),
}))

import { parseShortcutLaunch, runLarkEntryFlow } from "@/lib/connectors/lark-web/intent-client"
import { configureLarkJsSdk } from "@/lib/connectors/lark-web/jssdk"
import LarkShortcutPage from "./page"

const flowMock = runLarkEntryFlow as jest.MockedFunction<typeof runLarkEntryFlow>
const launchMock = parseShortcutLaunch as jest.MockedFunction<typeof parseShortcutLaunch>

describe("LarkShortcutPage (/lark/shortcut)", () => {
  beforeEach(() => {
    mockReplace.mockClear()
    flowMock.mockReset()
    launchMock.mockReturnValue({ triggerId: "t1", adapterId: "lk-1" })
    ;(configureLarkJsSdk as jest.Mock).mockClear()
    window.history.replaceState(null, "", "/lark/shortcut?__trigger_id__=t1&adapter_id=lk-1")
  })

  it("bootstraps the JSSDK, runs the flow, and navigates on success", async () => {
    flowMock.mockResolvedValue({
      kind: "navigate",
      conversationKey: "lark:lk-1:oc_1",
      imported: 2,
    })
    render(<LarkShortcutPage />)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/inbox/c?key=lark%3Alk-1%3Aoc_1"))
    expect(configureLarkJsSdk).toHaveBeenCalledWith(expect.objectContaining({ adapterId: "lk-1" }))
    expect(flowMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: "?__trigger_id__=t1&adapter_id=lk-1" })
    )
  })

  it("keeps importing even when the JSSDK bootstrap fails", async () => {
    ;(configureLarkJsSdk as jest.Mock).mockRejectedValueOnce(new Error("no sdk"))
    flowMock.mockResolvedValue({ kind: "error", code: "trigger_detail_failed" })
    render(<LarkShortcutPage />)
    expect(await screen.findByText("errors.trigger_detail_failed")).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
  })

  it("maps unknown server error codes onto the generic import_failed key", async () => {
    flowMock.mockResolvedValue({ kind: "error", code: "credentials_unavailable" })
    render(<LarkShortcutPage />)
    expect(await screen.findByText("errors.import_failed")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "openWorkbench" })).toHaveAttribute("href", "/")
  })

  it("bounces to SSO login when the flow demands it", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    flowMock.mockResolvedValue({
      kind: "login",
      loginUrl: "https://api.example/integrations/lark/web/login?adapter_id=lk-1",
    })
    render(<LarkShortcutPage />)
    expect(await screen.findByText("loginRedirect")).toBeInTheDocument()
    consoleError.mockRestore()
  })

  it("shows the create phase and no chat error when the + menu opens it", async () => {
    // No trigger code — the `+`-menu branch. The page must NOT report
    // trigger_missing; that was the whole reason the entry was unreachable.
    launchMock.mockReturnValue({ adapterId: "lk-1", chatId: "oc_1" })
    window.history.replaceState(null, "", "/lark/shortcut?adapter_id=lk-1&chat_id=oc_1")
    flowMock.mockResolvedValue({ kind: "navigate", conversationKey: "lark:lk-1:oc_1" })

    render(<LarkShortcutPage />)

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/inbox/c?key=lark%3Alk-1%3Aoc_1"))
    expect(flowMock).toHaveBeenCalledWith(
      expect.objectContaining({ search: "?adapter_id=lk-1&chat_id=oc_1" })
    )
  })

  it("renders chat_missing when the + menu passed no chat context", async () => {
    launchMock.mockReturnValue({ adapterId: "lk-1" })
    flowMock.mockResolvedValue({ kind: "error", code: "chat_missing" })

    render(<LarkShortcutPage />)

    expect(await screen.findByText("errors.chat_missing")).toBeInTheDocument()
  })
})
