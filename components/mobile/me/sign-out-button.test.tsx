/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import type { SignOutOutcome } from "@/hooks/companion/use-companion-sign-out"

const signOutMock: jest.Mock<Promise<SignOutOutcome>, []> = jest.fn(
  async (): Promise<SignOutOutcome> => ({ kind: "ok" })
)
let pendingValue = false

jest.mock("@/hooks/companion/use-companion-sign-out", () => ({
  useCompanionSignOut: () => ({ signOut: signOutMock, pending: pendingValue }),
}))

const toastMock = { success: jest.fn(), error: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    success: (m: string) => toastMock.success(m),
    error: (m: string) => toastMock.error(m),
  },
}))

import { SignOutButton } from "./sign-out-button"

beforeEach(() => {
  signOutMock.mockReset()
  signOutMock.mockResolvedValue({ kind: "ok" })
  pendingValue = false
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

async function openAndConfirm() {
  fireEvent.click(screen.getByTestId("me-sign-out"))
  const confirm = await screen.findByTestId("me-sign-out-confirm")
  fireEvent.click(confirm)
}

describe("<SignOutButton />", () => {
  it("renders the destructive CTA", () => {
    render(<SignOutButton />)
    expect(screen.getByTestId("me-sign-out")).toBeInTheDocument()
    expect(screen.getByTestId("me-sign-out")).toHaveTextContent("Sign out")
  })

  it("opens the confirm dialog and invokes signOut on confirm", async () => {
    render(<SignOutButton />)
    await openAndConfirm()
    await waitFor(() => expect(signOutMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
  })

  it("surfaces lockout as an error toast", async () => {
    signOutMock.mockResolvedValueOnce({ kind: "blocked", reason: "lockout" })
    render(<SignOutButton />)
    await openAndConfirm()
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("surfaces generic errors with the underlying message", async () => {
    signOutMock.mockResolvedValueOnce({
      kind: "blocked",
      reason: "error",
      message: "sensor offline",
    })
    render(<SignOutButton />)
    await openAndConfirm()
    await waitFor(() => expect(toastMock.error).toHaveBeenCalled())
  })

  it("silently closes when biometric is cancelled", async () => {
    signOutMock.mockResolvedValueOnce({ kind: "blocked", reason: "cancelled" })
    render(<SignOutButton />)
    await openAndConfirm()
    await waitFor(() => expect(signOutMock).toHaveBeenCalled())
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("disables the CTA when pending is true", () => {
    pendingValue = true
    render(<SignOutButton />)
    expect(screen.getByTestId("me-sign-out")).toBeDisabled()
  })
})
