/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { LocalAccountRecord } from "@/lib/accounts/account-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) =>
    values ? `${key}:${Object.values(values).join(",")}` : key,
}))

const renameMock = jest.fn<Promise<LocalAccountRecord>, [string, string]>()
const setAvatarMock = jest.fn<Promise<LocalAccountRecord>, [string, string | null]>()
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: (
    selector: (s: {
      renameAccount: typeof renameMock
      setAccountAvatar: typeof setAvatarMock
    }) => unknown
  ) => selector({ renameAccount: renameMock, setAccountAvatar: setAvatarMock }),
}))

jest.mock("@/components/settings/profile/profile-avatar-picker", () => ({
  ProfileAvatarPicker: ({ onChange }: { onChange: (v: string | null) => void }) => (
    <button type="button" data-testid="avatar-change" onClick={() => void onChange("data:new")}>
      avatar
    </button>
  ),
}))

import { AccountProfileTab } from "./account-profile-tab"

const account: LocalAccountRecord = {
  id: "acct_a",
  displayName: "Alpha",
  passwordVerifier: { algorithm: "a", salt: "s", hash: "h", params: {} },
  createdAt: Date.UTC(2024, 0, 1, 12),
  updatedAt: Date.UTC(2024, 0, 2, 12),
}

beforeEach(() => {
  jest.clearAllMocks()
  renameMock.mockResolvedValue(account)
  setAvatarMock.mockResolvedValue(account)
})

describe("AccountProfileTab", () => {
  it("renames the account", async () => {
    render(<AccountProfileTab account={account} />)
    fireEvent.change(screen.getByLabelText("editDisplayNameLabel"), {
      target: { value: "Renamed" },
    })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    await waitFor(() => expect(renameMock).toHaveBeenCalledWith("acct_a", "Renamed"))
  })

  it("does not rename when the name is unchanged", () => {
    render(<AccountProfileTab account={account} />)
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(renameMock).not.toHaveBeenCalled()
  })

  it("does not rename when edited to the same or empty name", () => {
    render(<AccountProfileTab account={account} />)
    fireEvent.change(screen.getByLabelText("editDisplayNameLabel"), {
      target: { value: "  Alpha  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    fireEvent.change(screen.getByLabelText("editDisplayNameLabel"), { target: { value: "   " } })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(renameMock).not.toHaveBeenCalled()
  })

  it("persists an avatar change through the shared picker", async () => {
    render(<AccountProfileTab account={account} />)
    fireEvent.click(screen.getByTestId("avatar-change"))
    await waitFor(() => expect(setAvatarMock).toHaveBeenCalledWith("acct_a", "data:new"))
  })

  it("surfaces avatar errors", async () => {
    setAvatarMock.mockRejectedValueOnce(new Error("avatar boom"))
    render(<AccountProfileTab account={account} />)
    fireEvent.click(screen.getByTestId("avatar-change"))
    expect(await screen.findByText("avatar boom")).toBeInTheDocument()
  })

  it("surfaces rename errors", async () => {
    renameMock.mockRejectedValueOnce(new Error("rename failed"))
    render(<AccountProfileTab account={account} />)
    fireEvent.change(screen.getByLabelText("editDisplayNameLabel"), { target: { value: "X" } })
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    expect(await screen.findByText("rename failed")).toBeInTheDocument()
  })

  it("renders created/updated metadata", () => {
    render(<AccountProfileTab account={account} />)
    expect(screen.getByTestId("account-metadata")).toBeInTheDocument()
  })
})
