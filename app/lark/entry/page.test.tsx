/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"

const mockReplace = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: mockReplace }),
  usePathname: () => "/lark/entry",
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/lib/connectors/lark-web/entry-client", () => ({
  resolveLarkEntry: jest.fn(),
}))

import { resolveLarkEntry } from "@/lib/connectors/lark-web/entry-client"
import type { LarkEntryOutcome } from "@/lib/connectors/lark-web/entry-client"
import LarkEntryPage from "./page"

const resolveMock = resolveLarkEntry as jest.MockedFunction<typeof resolveLarkEntry>

function deferred() {
  let resolve!: (outcome: LarkEntryOutcome) => void
  const promise = new Promise<LarkEntryOutcome>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe("LarkEntryPage (/lark/entry)", () => {
  beforeEach(() => {
    mockReplace.mockClear()
    resolveMock.mockReset()
    window.history.replaceState(null, "", "/lark/entry?entry=tok")
  })

  it("shows the resolving state while the entry client is in flight", () => {
    resolveMock.mockReturnValue(deferred().promise)
    render(<LarkEntryPage />)
    expect(screen.getByText("resolving")).toBeInTheDocument()
    expect(resolveMock).toHaveBeenCalledWith({
      search: "?entry=tok",
      returnTo: "/lark/entry?entry=tok",
    })
  })

  it("resolves the token exactly once across StrictMode double-mounts", async () => {
    resolveMock.mockResolvedValue({ kind: "navigate", conversationKey: "lark:lk-1:oc_1" })
    const { StrictMode } = await import("react")
    render(
      <StrictMode>
        <LarkEntryPage />
      </StrictMode>
    )
    await waitFor(() => expect(mockReplace).toHaveBeenCalled())
    expect(resolveMock).toHaveBeenCalledTimes(1)
  })

  it("navigates into the conversation with an encoded key", async () => {
    resolveMock.mockResolvedValue({ kind: "navigate", conversationKey: "lark:lk-1:oc_1" })
    render(<LarkEntryPage />)
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/inbox/c?key=lark%3Alk-1%3Aoc_1"))
  })

  it("bounces to the SSO login URL and shows the redirect notice", async () => {
    // jsdom cannot perform real navigation — location.assign logs a
    // "Not implemented" virtual-console error; silence it for this test.
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    resolveMock.mockResolvedValue({
      kind: "login",
      loginUrl: "https://api.example/integrations/lark/web/login?adapter_id=lk-1",
    })
    render(<LarkEntryPage />)
    expect(await screen.findByText("loginRedirect")).toBeInTheDocument()
    expect(mockReplace).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it("renders the error message and workbench fallback link on denial", async () => {
    resolveMock.mockResolvedValue({ kind: "error", code: "entry_expired" })
    render(<LarkEntryPage />)
    expect(await screen.findByText("errors.entry_expired")).toBeInTheDocument()
    const fallback = screen.getByRole("link", { name: "openWorkbench" })
    expect(fallback).toHaveAttribute("href", "/")
    expect(mockReplace).not.toHaveBeenCalled()
  })
})
