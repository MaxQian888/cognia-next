import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, args?: Record<string, unknown>) =>
    args ? `${key}:${JSON.stringify(args)}` : key,
}))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: jest.fn((select) => select({ unlockedAccountId: "owner", locked: false })),
}))
jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/automation/managed-desktop-result-deletion", () => ({
  listPendingManagedDesktopResultDeletions: jest.fn(),
  retryManagedDesktopResultDeletions: jest.fn(),
}))
import { useLiveQuery } from "dexie-react-hooks"
import { useAccountStore } from "@/stores/account/account-store"
import { retryManagedDesktopResultDeletions } from "@/lib/automation/managed-desktop-result-deletion"
import { ManagedDesktopCleanup } from "./managed-desktop-cleanup"
beforeEach(() => {
  jest.clearAllMocks()
  ;(useLiveQuery as jest.Mock).mockReturnValue([
    { id: "cleanup", host: { hostId: "original-host" }, phase: "committed", attempts: 2 },
  ])
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((select) =>
    select({ unlockedAccountId: "owner", locked: false })
  )
  ;(retryManagedDesktopResultDeletions as jest.Mock).mockResolvedValue(0)
})
test("pending physical cleanup remains visible without a conversation or result", async () => {
  render(<ManagedDesktopCleanup />)
  expect(screen.getByRole("region", { name: "title" })).toHaveTextContent("original-host")
  expect(screen.getByText(/item:/)).toHaveTextContent("pending")
  expect(retryManagedDesktopResultDeletions).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole("button", { name: "retry" }))
  await waitFor(() => expect(retryManagedDesktopResultDeletions).toHaveBeenCalledTimes(1))
  expect(screen.getByText(/item:/)).toBeInTheDocument()
})
test("retry failures are sanitized and retain the pending receipt", async () => {
  ;(retryManagedDesktopResultDeletions as jest.Mock).mockRejectedValue(new Error("secret-path"))
  render(<ManagedDesktopCleanup />)
  await userEvent.click(screen.getByRole("button", { name: "retry" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("failed")
  expect(screen.queryByText("secret-path")).not.toBeInTheDocument()
})
test("locked account cannot expose cleanup identities", () => {
  ;(useAccountStore as unknown as jest.Mock).mockImplementation((select) =>
    select({ locked: true })
  )
  render(<ManagedDesktopCleanup />)
  expect(screen.queryByRole("region")).not.toBeInTheDocument()
})
