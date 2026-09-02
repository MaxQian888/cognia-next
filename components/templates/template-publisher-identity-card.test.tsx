/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@/lib/templates/publisher-identity", () => ({
  getPublisherIdentity: jest.fn(),
  getOrCreatePublisherIdentity: jest.fn(),
  rotatePublisherIdentity: jest.fn(),
  publisherIdentityIsPersistent: jest.fn(() => true),
}))

import {
  getOrCreatePublisherIdentity,
  getPublisherIdentity,
  publisherIdentityIsPersistent,
  rotatePublisherIdentity,
} from "@/lib/templates/publisher-identity"
import { TemplatePublisherIdentityCard } from "./template-publisher-identity-card"

const getIdentity = getPublisherIdentity as jest.Mock
const createIdentity = getOrCreatePublisherIdentity as jest.Mock
const rotate = rotatePublisherIdentity as jest.Mock
const persistent = publisherIdentityIsPersistent as jest.Mock

const identity = {
  publicKey: "cHVibGlj",
  fingerprint: "a".repeat(64),
  publisher: "Acme",
  createdAt: 1,
}

describe("TemplatePublisherIdentityCard", () => {
  beforeEach(() => {
    persistent.mockReturnValue(true)
  })

  it("shows the fingerprint of the existing key", async () => {
    getIdentity.mockResolvedValue(identity)
    render(<TemplatePublisherIdentityCard />)
    expect(await screen.findByTestId("template-publisher-fingerprint")).toHaveTextContent(
      "a".repeat(64)
    )
    expect(screen.getByText("Acme")).toBeInTheDocument()
  })

  it("offers to create one when the device has no key yet", async () => {
    getIdentity.mockResolvedValue(null)
    createIdentity.mockResolvedValue(identity)
    const user = userEvent.setup()
    render(<TemplatePublisherIdentityCard />)
    await user.click(await screen.findByTestId("template-publisher-create"))
    expect(createIdentity).toHaveBeenCalled()
    expect(await screen.findByTestId("template-publisher-fingerprint")).toBeInTheDocument()
  })

  it("warns when the key only lives for this session", async () => {
    getIdentity.mockResolvedValue(identity)
    persistent.mockReturnValue(false)
    render(<TemplatePublisherIdentityCard />)
    expect(await screen.findByTestId("template-publisher-ephemeral")).toBeInTheDocument()
  })

  it("rotates only after the confirm is answered", async () => {
    getIdentity.mockResolvedValue(identity)
    rotate.mockResolvedValue({ ...identity, fingerprint: "b".repeat(64) })
    const user = userEvent.setup()
    render(<TemplatePublisherIdentityCard />)
    await user.click(await screen.findByTestId("template-publisher-rotate"))
    expect(rotate).not.toHaveBeenCalled()

    // Two buttons say "rotate" once the confirm is up (the trigger and the
    // dialog's action). The one inside the alert dialog is the confirm.
    const confirm = screen
      .getAllByRole("button", { name: "rotate" })
      .find((button) => button.closest("[role='alertdialog']"))
    await user.click(confirm!)
    await waitFor(() => expect(rotate).toHaveBeenCalled())
    expect(await screen.findByTestId("template-publisher-fingerprint")).toHaveTextContent(
      "b".repeat(64)
    )
  })

  it("copies the public key, not the fingerprint", async () => {
    getIdentity.mockResolvedValue(identity)
    const user = userEvent.setup()
    // After `setup()`, which installs its own clipboard stub over the one
    // jsdom does not have.
    const writeText = jest.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    })
    render(<TemplatePublisherIdentityCard />)
    await user.click(await screen.findByText("copyPublicKey"))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("cHVibGlj"))
  })

  it("re-reads when the refresh token changes", async () => {
    getIdentity.mockResolvedValue(null)
    const { rerender } = render(<TemplatePublisherIdentityCard refreshToken={0} />)
    await waitFor(() => expect(getIdentity).toHaveBeenCalledTimes(1))
    getIdentity.mockResolvedValue(identity)
    rerender(<TemplatePublisherIdentityCard refreshToken={1} />)
    expect(await screen.findByTestId("template-publisher-fingerprint")).toBeInTheDocument()
  })
})
