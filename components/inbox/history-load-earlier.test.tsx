/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars && "count" in vars ? `${key}:${vars.count}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), info: jest.fn() } }))

const mockHydrate = jest.fn()
let hookReturn: {
  hydrate: jest.Mock
  hydrating: boolean
  canHydrate: boolean
  lastCount: number | null
  error: "unsupported" | "failed" | null
}
jest.mock("@/hooks/connectors/use-history-hydration", () => ({
  useHistoryHydration: () => hookReturn,
}))

import { HistoryLoadEarlier } from "./history-load-earlier"
import { toast } from "sonner"

const mockToastSuccess = toast.success as jest.Mock
const mockToastInfo = toast.info as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  hookReturn = {
    hydrate: mockHydrate,
    hydrating: false,
    canHydrate: true,
    lastCount: null,
    error: null,
  }
})

describe("HistoryLoadEarlier", () => {
  it("renders an enabled button and toasts the inserted count on click", async () => {
    mockHydrate.mockResolvedValue(3)
    render(<HistoryLoadEarlier conversationKey="k" adapterId="adp" />)

    const btn = screen.getByRole("button", { name: "aria" })
    expect(btn).not.toBeDisabled()
    expect(screen.getByText("button")).toBeInTheDocument()

    fireEvent.click(btn)
    await waitFor(() => {
      expect(mockHydrate).toHaveBeenCalledTimes(1)
      expect(mockToastSuccess).toHaveBeenCalledWith("loaded:3")
    })
  })

  it("toasts 'none' when no earlier messages were found", async () => {
    mockHydrate.mockResolvedValue(0)
    render(<HistoryLoadEarlier conversationKey="k" adapterId="adp" />)
    fireEvent.click(screen.getByRole("button", { name: "aria" }))
    await waitFor(() => {
      expect(mockToastInfo).toHaveBeenCalledWith("none")
    })
  })

  it("disables the button in web mode (canHydrate=false)", () => {
    hookReturn = { ...hookReturn, canHydrate: false }
    render(<HistoryLoadEarlier conversationKey="k" adapterId="adp" />)
    expect(screen.getByRole("button", { name: "aria" })).toBeDisabled()
  })

  it("shows the loading label and disables while hydrating", () => {
    hookReturn = { ...hookReturn, hydrating: true }
    render(<HistoryLoadEarlier conversationKey="k" adapterId="adp" />)
    expect(screen.getByText("loading")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "aria" })).toBeDisabled()
  })

  it("surfaces a failed-load error message", () => {
    hookReturn = { ...hookReturn, error: "failed" }
    render(<HistoryLoadEarlier conversationKey="k" adapterId="adp" />)
    expect(screen.getByText("error")).toBeInTheDocument()
  })

  /**
   * The bar used to be unmounted entirely here, which made "the bot cannot
   * read history" indistinguishable from "there is nothing earlier" and from a
   * page that failed to render.
   */
  it("stays mounted, disabled and explained when the bot cannot fetch history", () => {
    render(
      <HistoryLoadEarlier
        conversationKey="k"
        adapterId="adp"
        unavailable={{
          available: false,
          capability: "history.fetch",
          cause: "missing_oauth_scope",
          detail: "channels:history",
          actionable: true,
        }}
      />
    )
    expect(screen.getByTestId("history-load-earlier-unavailable")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "aria" })).toBeDisabled()
    expect(screen.getByTestId("capability-notice")).toHaveAttribute(
      "data-cause",
      "missing_oauth_scope"
    )
  })

  // The capability is the more specific fact, and moving to the desktop app
  // would not fix it — so it must not be reported as a web-mode limitation.
  it("prefers the capability reason over the web-mode gate when both apply", () => {
    hookReturn = { ...hookReturn, canHydrate: false }
    render(
      <HistoryLoadEarlier
        conversationKey="k"
        adapterId="adp"
        unavailable={{
          available: false,
          capability: "history.fetch",
          cause: "not_declared",
          actionable: false,
        }}
      />
    )
    expect(screen.getByRole("button", { name: "aria" })).not.toHaveAttribute("title")
    expect(screen.getByTestId("capability-notice")).toHaveAttribute("data-cause", "not_declared")
  })
})
