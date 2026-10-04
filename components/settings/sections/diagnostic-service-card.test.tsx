/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { StoredDiagnosticConnection } from "@/lib/diagnostic-service/connection"

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

const connect = jest.fn(async (input: unknown) => input as StoredDiagnosticConnection)
const disconnect = jest.fn(async () => undefined)
const probeRole = jest.fn()
let state: Record<string, unknown> = {}

// The connection hook reaches the account store, which pulls in the agent-team
// and workflow graphs. Mocked at the module the way the /logs suite does it.
jest.mock("@/hooks/diagnostic-service/use-diagnostic-connection", () => ({
  useDiagnosticConnection: () => ({
    accountId: "account-a",
    connection: null,
    authenticated: false,
    loading: false,
    role: null,
    roleStatus: "unknown",
    roleErrorCode: null,
    probeRole,
    reachable: true,
    client: null,
    can: () => false,
    connect,
    disconnect,
    reload: jest.fn(),
    ...state,
  }),
}))

// "Can this device submit" — the desktop natively, a phone through the crash
// plugin — not "is this Tauri".
let supported = true
jest.mock("@/hooks/diagnostic-service/use-diagnostic-submission-support", () => ({
  useDiagnosticSubmissionSupport: () => ({
    runtime: supported ? "mobile" : null,
    supported,
    checking: false,
  }),
}))

import { DiagnosticServiceCard } from "./diagnostic-service-card"

const stored: StoredDiagnosticConnection = {
  baseUrl: "https://diag.example.com",
  tenantId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  installationId: "inst_x",
  autoSubmit: false,
  lastKnownRole: "triager",
}

beforeEach(() => {
  state = {}
  supported = true
  probeRole.mockClear()
  connect.mockClear()
  disconnect.mockClear()
})

/**
 * Render and let the seeding effect settle.
 *
 * The card defers its form seeding to a microtask so it never calls setState
 * synchronously inside an effect (`react-hooks/set-state-in-effect`). Flushing
 * here keeps every assertion about the settled card rather than about a
 * pending render.
 */
async function renderCard() {
  let view: ReturnType<typeof render> | undefined
  await act(async () => {
    view = render(<DiagnosticServiceCard />)
  })
  return view!
}

async function fill(url: string, tenant: string, project: string) {
  const user = userEvent.setup()
  await user.clear(screen.getByLabelText("settings.diagnostics.service.url"))
  await user.type(screen.getByLabelText("settings.diagnostics.service.url"), url)
  await user.clear(screen.getByLabelText("settings.diagnostics.service.tenantId"))
  await user.type(screen.getByLabelText("settings.diagnostics.service.tenantId"), tenant)
  await user.clear(screen.getByLabelText("settings.diagnostics.service.projectId"))
  await user.type(screen.getByLabelText("settings.diagnostics.service.projectId"), project)
  return user
}

describe("DiagnosticServiceCard", () => {
  it("starts disconnected and offers no disconnect button", async () => {
    await renderCard()
    expect(screen.getByText("settings.diagnostics.service.disconnected")).toBeInTheDocument()
    expect(screen.queryByTestId("diagnostic-service-disconnect")).toBeNull()
  })

  it("refuses a URL that is not http(s) before touching storage", async () => {
    await renderCard()
    const user = await fill("javascript:alert(1)", stored.tenantId, stored.projectId)
    await user.click(screen.getByText("settings.diagnostics.service.connect"))
    expect(screen.getByTestId("diagnostic-service-error")).toHaveTextContent(
      "settings.diagnostics.service.errors.url"
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it("refuses tenant and project ids that are not UUIDs", async () => {
    await renderCard()
    const user = await fill("https://diag.example.com", "not-a-uuid", stored.projectId)
    await user.click(screen.getByText("settings.diagnostics.service.connect"))
    expect(screen.getByTestId("diagnostic-service-error")).toHaveTextContent(
      "settings.diagnostics.service.errors.ids"
    )
    expect(connect).not.toHaveBeenCalled()
  })

  it("normalizes the URL and stores the session token separately", async () => {
    await renderCard()
    const user = await fill("diag.example.com/", stored.tenantId, stored.projectId)
    await user.type(
      screen.getByLabelText("settings.diagnostics.service.sessionToken"),
      "session-jwt"
    )
    await user.click(screen.getByText("settings.diagnostics.service.connect"))

    await waitFor(() => expect(connect).toHaveBeenCalled())
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://diag.example.com",
        tenantId: stored.tenantId,
        sessionToken: "session-jwt",
      })
    )
    // Cleared from the form once handed over — it lives in the keychain now.
    expect(screen.getByLabelText("settings.diagnostics.service.sessionToken")).toHaveValue("")
  })

  it("omits the token entirely when the field is left blank", async () => {
    await renderCard()
    const user = await fill("https://diag.example.com", stored.tenantId, stored.projectId)
    await user.click(screen.getByText("settings.diagnostics.service.connect"))
    await waitFor(() => expect(connect).toHaveBeenCalled())
    // A desktop install submits with its own installation proof; sending an
    // empty string would look like a token and fail the exchange.
    expect(connect.mock.calls[0][0]).not.toHaveProperty("sessionToken", "")
    expect((connect.mock.calls[0][0] as { sessionToken?: string }).sessionToken).toBeUndefined()
  })

  it("seeds the form from a stored connection and shows its role", async () => {
    state = { connection: stored, authenticated: true, role: "triager" }
    await renderCard()
    await waitFor(() =>
      expect(screen.getByLabelText("settings.diagnostics.service.url")).toHaveValue(stored.baseUrl)
    )
    expect(screen.getByText("settings.diagnostics.service.connected")).toBeInTheDocument()
    expect(screen.getByText("settings.diagnostics.service.roles.triager")).toBeInTheDocument()
    expect(screen.getByTestId("diagnostic-service-disconnect")).toBeInTheDocument()
  })

  it("drops both halves of the connection on disconnect", async () => {
    state = { connection: stored, authenticated: true }
    await renderCard()
    await userEvent.click(screen.getByTestId("diagnostic-service-disconnect"))
    expect(disconnect).toHaveBeenCalled()
  })

  it("warns that a browser is at the mercy of the service's CORS policy", async () => {
    state = { reachable: false }
    await renderCard()
    expect(screen.getByTestId("diagnostic-service-unreachable")).toBeInTheDocument()
  })

  it("only offers automatic submission where this device can submit", async () => {
    state = { connection: stored, authenticated: true }
    supported = false
    const { unmount } = await renderCard()
    expect(screen.queryByLabelText("settings.diagnostics.service.autoSubmit")).toBeNull()
    unmount()

    // A phone with the crash plugin counts; it used to be desktop-only.
    supported = true
    await renderCard()
    const toggle = screen.getByLabelText("settings.diagnostics.service.autoSubmit")
    expect(toggle).toBeInTheDocument()
    await userEvent.click(toggle)
    // Off by default, and turning it on is its own decision — never implied by
    // having configured a service. It is stamped, so it never covers a backlog.
    const call = connect.mock.calls.at(-1)?.[0] as StoredDiagnosticConnection
    expect(call.autoSubmit).toBe(true)
    expect(Number.isNaN(Date.parse(call.autoSubmitSince ?? ""))).toBe(false)
  })

  it("clears the stamp when automatic submission is turned off", async () => {
    state = {
      connection: { ...stored, autoSubmit: true, autoSubmitSince: "2026-10-01T00:00:00.000Z" },
      authenticated: true,
    }
    await renderCard()
    await userEvent.click(screen.getByLabelText("settings.diagnostics.service.autoSubmit"))
    const call = connect.mock.calls.at(-1)?.[0] as StoredDiagnosticConnection
    expect(call.autoSubmit).toBe(false)
    expect(call.autoSubmitSince).toBeUndefined()
  })

  it("shows the role being learned after a token is saved", async () => {
    state = { connection: stored, authenticated: true, role: null, roleStatus: "probing" }
    await renderCard()
    expect(screen.getByTestId("diagnostic-service-role-probing")).toHaveTextContent(
      "settings.diagnostics.service.roleProbing"
    )
  })

  it("reports a refused token and retries the probe on demand", async () => {
    state = {
      connection: stored,
      authenticated: true,
      role: null,
      roleStatus: "failed",
      roleErrorCode: "invalid_oidc_session",
    }
    await renderCard()
    expect(screen.getByTestId("diagnostic-service-role-failed")).toHaveTextContent(
      "settings.diagnostics.service.roleErrors.invalid_oidc_session"
    )
    await userEvent.click(screen.getByText("settings.diagnostics.service.roleRetry"))
    expect(probeRole).toHaveBeenCalled()
  })

  it("degrades an unrecognized probe failure to the generic message", async () => {
    state = {
      connection: stored,
      authenticated: true,
      roleStatus: "failed",
      roleErrorCode: "http_502",
    }
    await renderCard()
    expect(screen.getByTestId("diagnostic-service-role-failed")).toHaveTextContent(
      "settings.diagnostics.service.roleErrors.other"
    )
  })
})
