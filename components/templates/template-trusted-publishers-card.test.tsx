/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@/lib/db/trusted-publishers", () => ({
  listTrustedPublishers: jest.fn(),
  revokePublisher: jest.fn(),
}))

import { listTrustedPublishers, revokePublisher } from "@/lib/db/trusted-publishers"
import { TemplateTrustedPublishersCard } from "./template-trusted-publishers-card"

const list = listTrustedPublishers as jest.Mock
const revoke = revokePublisher as jest.Mock

const row = {
  publicKey: "cHVibGlj",
  fingerprint: "c".repeat(64),
  authorName: "Acme",
  firstTrustedAt: 1,
  lastSeenAt: 2,
  installCount: 1,
}

describe("TemplateTrustedPublishersCard", () => {
  it("lists each trusted key by name and fingerprint", async () => {
    list.mockResolvedValue([row])
    render(<TemplateTrustedPublishersCard />)
    expect(await screen.findByTestId("template-trusted-publisher-row")).toHaveTextContent("Acme")
    expect(screen.getByTestId("template-trusted-publisher-row")).toHaveTextContent("c".repeat(64))
  })

  it("names an anonymous key rather than rendering a blank row", async () => {
    list.mockResolvedValue([{ ...row, authorName: undefined }])
    render(<TemplateTrustedPublishersCard />)
    expect(await screen.findByTestId("template-trusted-publisher-row")).toHaveTextContent("unnamed")
  })

  it("says so when nothing is trusted yet", async () => {
    list.mockResolvedValue([])
    render(<TemplateTrustedPublishersCard />)
    expect(await screen.findByText("empty")).toBeInTheDocument()
  })

  it("untrusts only after the confirm is answered, then re-reads", async () => {
    list.mockResolvedValue([row])
    revoke.mockResolvedValue(undefined)
    const user = userEvent.setup()
    render(<TemplateTrustedPublishersCard />)
    await user.click(await screen.findByTestId("template-trusted-publisher-revoke"))
    expect(revoke).not.toHaveBeenCalled()

    const confirm = screen
      .getAllByRole("button", { name: "revoke" })
      .find((button) => button.closest("[role='alertdialog']"))
    await user.click(confirm!)
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("cHVibGlj"))
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
  })

  it("re-reads when the refresh token changes", async () => {
    list.mockResolvedValue([])
    const { rerender } = render(<TemplateTrustedPublishersCard refreshToken={0} />)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    list.mockResolvedValue([row])
    rerender(<TemplateTrustedPublishersCard refreshToken={1} />)
    expect(await screen.findByTestId("template-trusted-publisher-row")).toBeInTheDocument()
  })
})
