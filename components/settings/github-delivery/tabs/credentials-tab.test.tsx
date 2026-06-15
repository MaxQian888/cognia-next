import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import { CredentialsTab } from "./credentials-tab"

const fakePut = jest.fn()
const fakeTable = { put: fakePut }
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ table: () => fakeTable }),
}))

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CredentialsTab />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  fakePut.mockReset()
  fakePut.mockResolvedValue(undefined)
})

describe("CredentialsTab", () => {
  it("renders the App / PAT picker by default", () => {
    renderTab()
    expect(screen.getByTestId("credentials-picker")).toBeInTheDocument()
  })

  it("switches to the PAT wizard when 'Set up PAT' is chosen", () => {
    renderTab()
    fireEvent.click(screen.getByRole("button", { name: /Set up PAT/i }))
    expect(screen.getByTestId("credentials-pat-wizard")).toBeInTheDocument()
  })

  it("PAT wizard rejects malformed repo names", async () => {
    renderTab()
    fireEvent.click(screen.getByRole("button", { name: /Set up PAT/i }))
    fireEvent.change(screen.getByTestId("pat-repo-input"), { target: { value: "not-a-slash" } })
    fireEvent.change(screen.getByTestId("pat-token-input"), { target: { value: "ghp_x" } })
    fireEvent.click(screen.getByTestId("pat-save-button"))
    expect(await screen.findByText(/Repo must be in/)).toBeInTheDocument()
    expect(fakePut).not.toHaveBeenCalled()
  })

  it("PAT wizard saves a valid entry and shows success", async () => {
    renderTab()
    fireEvent.click(screen.getByRole("button", { name: /Set up PAT/i }))
    fireEvent.change(screen.getByTestId("pat-repo-input"), {
      target: { value: "octocat/hello-world" },
    })
    fireEvent.change(screen.getByTestId("pat-token-input"), { target: { value: "ghp_testtoken" } })
    fireEvent.click(screen.getByTestId("pat-save-button"))
    await waitFor(() => expect(fakePut).toHaveBeenCalledTimes(1))
    expect(fakePut.mock.calls[0][0]).toMatchObject({
      fullName: "octocat/hello-world",
      credentialMode: "pat",
      patToken: "ghp_testtoken",
      triggerMode: "webhook",
      worktreeMode: "local",
    })
    expect(await screen.findByText(/Saved octocat\/hello-world/)).toBeInTheDocument()
  })

  it("App wizard validates numeric IDs and non-empty key", async () => {
    renderTab()
    fireEvent.click(screen.getByRole("button", { name: /Set up App/i }))
    fireEvent.change(screen.getByTestId("app-repo-input"), {
      target: { value: "octocat/hello-world" },
    })
    fireEvent.change(screen.getByTestId("app-id-input"), { target: { value: "abc" } })
    fireEvent.change(screen.getByTestId("app-installation-input"), { target: { value: "1" } })
    fireEvent.change(screen.getByTestId("app-pk-input"), { target: { value: "key" } })
    fireEvent.click(screen.getByTestId("app-save-button"))
    expect(await screen.findByText(/must be numbers/)).toBeInTheDocument()
    expect(fakePut).not.toHaveBeenCalled()
  })

  it("App wizard saves a valid entry", async () => {
    renderTab()
    fireEvent.click(screen.getByRole("button", { name: /Set up App/i }))
    fireEvent.change(screen.getByTestId("app-repo-input"), {
      target: { value: "octocat/hello-world" },
    })
    fireEvent.change(screen.getByTestId("app-id-input"), { target: { value: "12345" } })
    fireEvent.change(screen.getByTestId("app-installation-input"), {
      target: { value: "99999" },
    })
    fireEvent.change(screen.getByTestId("app-pk-input"), {
      target: { value: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----" },
    })
    fireEvent.click(screen.getByTestId("app-save-button"))
    await waitFor(() => expect(fakePut).toHaveBeenCalledTimes(1))
    expect(fakePut.mock.calls[0][0]).toMatchObject({
      fullName: "octocat/hello-world",
      credentialMode: "app",
      appId: 12345,
      installationId: 99999,
    })
  })
})
