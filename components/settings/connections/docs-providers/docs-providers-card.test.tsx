import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), warning: jest.fn() },
}))
jest.mock("@/lib/native/opener", () => ({ openUrl: jest.fn(async () => undefined) }))
jest.mock("@/lib/db/adapter-instances", () => ({ listAdapterInstancesByType: jest.fn() }))
jest.mock("@/lib/docs-providers", () => ({
  ...jest.requireActual("@/lib/docs-providers/types"),
  larkDocsProvider: { id: "lark", mentionPrefix: "lark:", hosts: ["tauri"] },
  googleDocsProvider: { id: "google", mentionPrefix: "gdoc:", hosts: ["tauri"] },
}))
// The card asks `docsProviderReach`, which asks the host profile. Driving the
// profile (rather than a `hostSupported` boolean) is what lets these tests
// tell a standalone browser apart from a paired companion.
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: jest.fn(() => "desktop") }))
jest.mock("@/lib/docs-providers/providers/google/config", () => ({
  GOOGLE_DOCS_SCOPES: ["https://www.googleapis.com/auth/drive.readonly"],
  getGoogleDocsSettings: jest.fn(async () => ({})),
  saveGoogleClientSecret: jest.fn(async () => undefined),
  updateGoogleDocsSettings: jest.fn(async () => ({})),
  clearGoogleConnection: jest.fn(async () => undefined),
  subscribeGoogleDocsSettings: jest.fn(() => () => undefined),
}))
jest.mock("@/lib/docs-providers/providers/google/auth", () => ({
  beginGoogleDocsAuth: jest.fn(async () => ({
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    redirectUri: "http://127.0.0.1:7842/oauth/docs/google/callback",
  })),
  disconnectGoogleDocs: jest.fn(async () => ({ revoked: true })),
}))

import { toast } from "sonner"
import { openUrl } from "@/lib/native/opener"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { DocsProviderError } from "@/lib/docs-providers"
import { useHostProfile } from "@/hooks/use-host-profile"
import {
  getGoogleDocsSettings,
  subscribeGoogleDocsSettings,
  saveGoogleClientSecret,
  updateGoogleDocsSettings,
} from "@/lib/docs-providers/providers/google/config"
import {
  beginGoogleDocsAuth,
  disconnectGoogleDocs,
} from "@/lib/docs-providers/providers/google/auth"
import { DocsProvidersCard } from "./docs-providers-card"

const hostProfileMock = useHostProfile as jest.Mock
const listAdaptersMock = listAdapterInstancesByType as jest.Mock
const getSettingsMock = getGoogleDocsSettings as jest.Mock
const beginAuthMock = beginGoogleDocsAuth as jest.Mock
const disconnectMock = disconnectGoogleDocs as jest.Mock

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DocsProvidersCard />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  hostProfileMock.mockReturnValue("desktop")
  listAdaptersMock.mockResolvedValue([])
  getSettingsMock.mockResolvedValue({})
  ;(subscribeGoogleDocsSettings as jest.Mock).mockImplementation(() => () => undefined)
})

describe("DocsProvidersCard — host gating", () => {
  it("keeps both rows and names the reason off the desktop shell", () => {
    hostProfileMock.mockReturnValue("mobile-companion")
    renderCard()
    // Rendered, not removed: hiding them told a paired phone nothing about
    // the desktop next to it that already holds both accounts.
    expect(screen.getByTestId("docs-provider-lark")).toBeInTheDocument()
    expect(screen.getByTestId("docs-provider-google")).toBeInTheDocument()
    expect(screen.getByTestId("docs-provider-google-notice")).toHaveAttribute(
      "data-cause",
      "runs-on-host"
    )
  })

  it("tells a standalone browser something different from a companion", () => {
    hostProfileMock.mockReturnValue("web-standalone")
    renderCard()
    expect(screen.getByTestId("docs-provider-lark-notice")).toHaveAttribute(
      "data-cause",
      "no-runtime"
    )
  })

  it("makes the Google controls inert rather than absent when blocked", () => {
    hostProfileMock.mockReturnValue("web-standalone")
    renderCard()
    expect(screen.getByTestId("docs-provider-google-connect")).toBeDisabled()
  })

  it("renders no notice on the desktop shell", () => {
    renderCard()
    expect(screen.queryByTestId("docs-provider-google-notice")).not.toBeInTheDocument()
    expect(screen.queryByTestId("docs-provider-lark-notice")).not.toBeInTheDocument()
  })
})

describe("DocsProvidersCard — Feishu row", () => {
  it("says no Feishu account is bound yet", async () => {
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-lark-status")).toHaveTextContent(
        "No Feishu account is connected yet."
      )
    )
  })

  it("counts only enabled Lark adapters", async () => {
    listAdaptersMock.mockResolvedValue([
      { id: "a", enabled: true },
      { id: "b", enabled: true },
      { id: "c", enabled: false },
    ])
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-lark-status")).toHaveTextContent("2 connected")
    )
  })

  it("never asks for Feishu credentials — it borrows the connector's", async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId("docs-provider-lark")).toBeInTheDocument())
    expect(screen.getByTestId("docs-provider-lark").querySelector("input")).toBeNull()
  })
})

describe("DocsProvidersCard — Google row", () => {
  it("shows the disconnected state and the requested read scopes", async () => {
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-google-status")).toHaveTextContent("Not connected")
    )
    expect(screen.getByText("drive.readonly")).toBeInTheDocument()
  })

  it("shows the connected account instead of the form once connected", async () => {
    getSettingsMock.mockResolvedValue({
      clientId: "cid",
      connected: true,
      accountEmail: "ada@example.com",
    })
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-google-status")).toHaveTextContent("ada@example.com")
    )
    expect(screen.queryByTestId("docs-provider-google-connect")).not.toBeInTheDocument()
  })

  it("keeps Connect disabled until a client id is supplied", async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId("docs-provider-google-connect")).toBeDisabled())
  })

  it("persists the credential, then opens the consent page in the real browser", async () => {
    const user = userEvent.setup()
    renderCard()
    await waitFor(() => expect(screen.getByTestId("docs-provider-google-connect")).toBeDisabled())

    await user.type(screen.getByLabelText("OAuth client ID"), "cid.apps.googleusercontent.com")
    await user.type(screen.getByLabelText("OAuth client secret"), "shh")
    await user.click(screen.getByTestId("docs-provider-google-connect"))

    await waitFor(() => expect(beginAuthMock).toHaveBeenCalled())
    expect(updateGoogleDocsSettings).toHaveBeenCalledWith({
      clientId: "cid.apps.googleusercontent.com",
    })
    expect(saveGoogleClientSecret).toHaveBeenCalledWith("shh")
    // Google blocks sign-in from embedded webviews, so this must be the system browser.
    expect(openUrl).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?x=1")
  })

  it("reports a localized reason when the hand-off cannot start", async () => {
    const user = userEvent.setup()
    beginAuthMock.mockRejectedValue(new DocsProviderError("hostUnsupported"))
    renderCard()
    await waitFor(() => expect(screen.getByTestId("docs-provider-google-connect")).toBeDisabled())
    await user.type(screen.getByLabelText("OAuth client ID"), "cid")
    await user.click(screen.getByTestId("docs-provider-google-connect"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("desktop app only"))
    )
  })

  it("revokes at Google and clears the connection on disconnect", async () => {
    const user = userEvent.setup()
    disconnectMock.mockResolvedValue({ revoked: true })
    getSettingsMock.mockResolvedValue({ connected: true, accountEmail: "ada@example.com" })
    renderCard()
    await user.click(await screen.findByRole("button", { name: "Disconnect" }))
    // Clearing the keyring alone would leave a live grant on Google's side.
    await waitFor(() => expect(disconnectMock).toHaveBeenCalled())
    expect(screen.getByTestId("docs-provider-google-status")).toHaveTextContent("Not connected")
    expect(toast.success).toHaveBeenCalledWith(
      "Disconnected. The Google authorization has been revoked."
    )
  })

  it("tells the user to finish at Google when revocation failed", async () => {
    const user = userEvent.setup()
    disconnectMock.mockResolvedValue({ revoked: false, reason: "backend error" })
    getSettingsMock.mockResolvedValue({ connected: true, accountEmail: "ada@example.com" })
    renderCard()
    await user.click(await screen.findByRole("button", { name: "Disconnect" }))

    // Local state still clears — the warning is the only thing that differs,
    // because the grant may still stand and only the user can finish it.
    await waitFor(() =>
      expect(screen.getByTestId("docs-provider-google-status")).toHaveTextContent("Not connected")
    )
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining("backend error"))
  })
})

it("updates connection state after OAuth completes and after credentials are invalidated", async () => {
  let notify: ((settings: { connected?: boolean; accountEmail?: string }) => void) | undefined
  const unsubscribe = jest.fn()
  ;(subscribeGoogleDocsSettings as jest.Mock).mockImplementation((listener) => {
    notify = listener
    return unsubscribe
  })
  const view = renderCard()
  await waitFor(() => expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument())
  act(() => notify?.({ connected: true, accountEmail: "user@example.test" }))
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument()
  expect(screen.getByText(/user@example.test/)).toBeInTheDocument()
  act(() => notify?.({ connected: false }))
  expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument()
  expect(screen.queryByText(/user@example.test/)).not.toBeInTheDocument()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(1)
})

it("keeps a newer connection notification when the initial read resolves late", async () => {
  let resolve!: (settings: { connected: boolean }) => void
  getSettingsMock.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done
    })
  )
  let notify: ((settings: { connected: boolean; accountEmail?: string }) => void) | undefined
  ;(subscribeGoogleDocsSettings as jest.Mock).mockImplementation((listener) => {
    notify = listener
    return () => undefined
  })
  renderCard()
  act(() => notify?.({ connected: true, accountEmail: "fresh@example.test" }))
  await act(async () => resolve({ connected: false }))
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeInTheDocument()
  expect(screen.getByText(/fresh@example.test/)).toBeInTheDocument()
})

it("reports disconnect storage failures without an unhandled rejection or success toast", async () => {
  getSettingsMock.mockResolvedValue({ clientId: "cid", connected: true })
  disconnectMock.mockRejectedValueOnce(new Error("keyring unavailable"))
  const user = userEvent.setup()
  renderCard()
  await user.click(await screen.findByRole("button", { name: "Disconnect" }))
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("keyring unavailable"))
  )
  expect(toast.success).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeEnabled()
})

it("keeps the disconnecting label while remote revocation is pending after local clear", async () => {
  getSettingsMock.mockResolvedValue({ clientId: "cid", connected: true })
  let notify: ((settings: { clientId?: string; connected: boolean }) => void) | undefined
  ;(subscribeGoogleDocsSettings as jest.Mock).mockImplementation((listener) => {
    notify = listener
    return () => undefined
  })
  let finish!: (outcome: { revoked: true }) => void
  disconnectMock.mockImplementationOnce(() => {
    notify?.({ clientId: "cid", connected: false })
    return new Promise((resolve) => {
      finish = resolve
    })
  })
  const user = userEvent.setup()
  renderCard()
  await user.click(await screen.findByRole("button", { name: "Disconnect" }))
  expect(screen.getByRole("button", { name: "Disconnecting…" })).toBeDisabled()
  await act(async () => finish({ revoked: true }))
  expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled()
})
