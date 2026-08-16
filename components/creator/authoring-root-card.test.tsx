/** @jest-environment jsdom */
const mockOpen = jest.fn<Promise<string | null>, unknown[]>(async () => null)
jest.mock("@tauri-apps/plugin-dialog", () => ({ open: (...args: unknown[]) => mockOpen(...args) }))

const mockCanUseTauriInvoke = jest.fn(() => true)
jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: () => mockCanUseTauriInvoke(),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { AuthoringRootCard } from "./authoring-root-card"
import creatorMessages from "@/i18n/messages/en/creator.json"
import { useCreatorStore } from "@/stores/creator/creator-store"

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={{ creator: creatorMessages }}>
      <AuthoringRootCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockOpen.mockReset()
  mockOpen.mockResolvedValue(null)
  mockCanUseTauriInvoke.mockReturnValue(true)
  useCreatorStore.setState({
    authoringRoot: null,
    activeRunId: null,
    artifactKind: "plugin",
    approvedAdditions: [],
  })
})

describe("AuthoringRootCard", () => {
  it("starts with no root and offers a picker", () => {
    renderCard()
    expect(screen.getByText(creatorMessages.root.empty)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Choose a directory/ })).toBeEnabled()
  })

  it("grants the picked directory", async () => {
    mockOpen.mockResolvedValue("/work/authoring")
    renderCard()
    fireEvent.click(screen.getByRole("button", { name: /Choose a directory/ }))

    await waitFor(() =>
      expect(useCreatorStore.getState().authoringRoot?.path).toBe("/work/authoring")
    )
    expect(mockOpen).toHaveBeenCalledWith(expect.objectContaining({ directory: true }))
  })

  it("leaves the grant untouched when the user cancels", async () => {
    renderCard()
    fireEvent.click(screen.getByRole("button", { name: /Choose a directory/ }))
    await waitFor(() => expect(mockOpen).toHaveBeenCalled())
    expect(useCreatorStore.getState().authoringRoot).toBeNull()
  })

  it("shows why a rejected directory was refused", async () => {
    mockOpen.mockResolvedValue("/")
    renderCard()
    fireEvent.click(screen.getByRole("button", { name: /Choose a directory/ }))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        creatorMessages.root.rejected["filesystem-root"]
      )
    )
    expect(useCreatorStore.getState().authoringRoot).toBeNull()
  })

  it("renders the granted root and allows revoking it", () => {
    useCreatorStore.setState({
      authoringRoot: {
        path: "/work/authoring",
        label: "authoring",
        origin: "selected",
        grantedAt: 0,
      },
    })
    renderCard()
    expect(screen.getByText("authoring")).toBeInTheDocument()
    expect(screen.getByText(/\/work\/authoring/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: creatorMessages.root.revoke }))
    expect(useCreatorStore.getState().authoringRoot).toBeNull()
  })

  // There is deliberately no "use the current workspace" fallback: without a
  // host that can show a real picker, the card offers nothing.
  it("disables the picker when the host cannot show a directory dialog", () => {
    mockCanUseTauriInvoke.mockReturnValue(false)
    renderCard()
    expect(screen.getByRole("button", { name: /Choose a directory/ })).toBeDisabled()
  })

  it("does not open a dialog when the host is unsupported", async () => {
    mockCanUseTauriInvoke.mockReturnValue(false)
    renderCard()
    // The button is disabled, but the guard is asserted independently so a
    // future styling change cannot turn this into an unchecked path.
    fireEvent.click(screen.getByRole("button", { name: /Choose a directory/ }))
    await waitFor(() => expect(mockOpen).not.toHaveBeenCalled())
  })
})
