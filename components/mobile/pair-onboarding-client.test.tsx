/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  PairOnboardingClient,
  describeHttpError,
  describeNetworkError,
  validateBaseUrl,
  validatePairJwt,
} from "./pair-onboarding-client"

// A valid-shape JWT for tests that exercise the network layer (not validation).
const VALID_JWT = "aaa.bbb.ccc"

// Stub the transport singleton — we don't want the real selector to run.
jest.mock("@/lib/tauri", () => ({
  transport: {
    call: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
    constructor: { name: "MockTransport" },
  },
}))

// Mock the QR scanner so the dynamic-import never tries to resolve the
// native plugin during jsdom tests. The pair page now reads from
// `lib/capacitor/barcode` (Wave 1.7); the legacy mock path stays so any
// transitive callers keep working.
jest.mock("@/lib/capacitor/barcode", () => ({
  scan: jest.fn(),
}))
jest.mock("@/lib/qr/barcode-scanner", () => ({
  scanQrCode: jest.fn(),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    // Mirror the strings the test expectations match against. Keep keys
    // here in sync with i18n/messages/* — these are NOT a runtime fallback,
    // just a static stub for jsdom.
    const map: Record<string, string> = {
      title: "Pair with cognia desktop",
      intro: "Enter the desktop's LAN address and the pairing code from Settings → Companion.",
      scanCta: "Scan QR",
      manualDivider: "or paste manually",
      baseUrlLabel: "Server URL",
      tokenLabel: "Pair token",
      fingerprintPinned: "Desktop identity pinned",
      submit: "Pair",
      submitInProgress: "Pairing…",
      transportLabel: "Transport",
      signOutTitle: "Sign out",
      signOutReason: "Confirm sign out",
      signOutDescription: "Reconnect requires re-pairing.",
      biometricFailed: `Biometric failed (${(vars?.reason as string) ?? ""})`,
    }
    return map[key] ?? key
  },
}))

import { scan as scanBarcode } from "@/lib/capacitor/barcode"
const mockedScanQr = scanBarcode as jest.Mock

// Force a clean cache + storage between tests.
beforeEach(() => {
  window.localStorage.clear()
  ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn()
})

afterEach(() => {
  jest.clearAllMocks()
  mockedScanQr.mockReset()
})

describe("<PairOnboardingClient />", () => {
  it("renders the pair form when not yet paired", async () => {
    render(<PairOnboardingClient />)

    expect(await screen.findByTestId("pair-baseurl")).toBeInTheDocument()
    expect(screen.getByTestId("pair-jwt")).toBeInTheDocument()
    expect(screen.getByTestId("pair-submit")).toBeInTheDocument()
  })

  it("shows an error when baseUrl or pair JWT is empty on submit", async () => {
    const user = userEvent.setup()
    render(<PairOnboardingClient />)

    await user.click(await screen.findByTestId("pair-submit"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/required/i)
  })

  it("transitions to paired status after a successful pair", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          device_id: "dev-001",
          device_jwt: "jwt.value",
          server_version: "0.1.0",
        }),
      text: () => Promise.resolve(""),
    })

    const user = userEvent.setup()
    render(<PairOnboardingClient />)

    fireEvent.change(await screen.findByTestId("pair-baseurl"), {
      target: { value: "http://192.168.1.42:7890" },
    })
    fireEvent.change(screen.getByTestId("pair-jwt"), {
      target: { value: VALID_JWT },
    })
    await user.click(screen.getByTestId("pair-submit"))

    await waitFor(() => expect(screen.getByTestId("pair-status")).toBeInTheDocument())
    expect(screen.getByTestId("pair-status")).toHaveTextContent("dev-001")
    expect(screen.getByTestId("pair-status")).toHaveTextContent("0.1.0")
    expect(fetchMock).toHaveBeenCalledWith(
      "http://192.168.1.42:7890/api/v1/auth/pair",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "Content-Type": "application/json" }),
      })
    )
  })

  it("renders an actionable error when the pair endpoint returns 401", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve("invalid pair JWT"),
    })

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    fireEvent.change(await screen.findByTestId("pair-baseurl"), {
      target: { value: "http://test:7890" },
    })
    fireEvent.change(screen.getByTestId("pair-jwt"), {
      target: { value: VALID_JWT },
    })
    await user.click(screen.getByTestId("pair-submit"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/expired|already been used/i)
  })

  it("renders the network-down hint when fetch rejects with a network error", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockRejectedValueOnce(new Error("Failed to fetch"))

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    fireEvent.change(await screen.findByTestId("pair-baseurl"), {
      target: { value: "http://nope:7890" },
    })
    fireEvent.change(screen.getByTestId("pair-jwt"), {
      target: { value: VALID_JWT },
    })
    await user.click(screen.getByTestId("pair-submit"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/same network/i)
  })

  it("rejects malformed pair JWT before any fetch", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    fireEvent.change(await screen.findByTestId("pair-baseurl"), {
      target: { value: "http://test:7890" },
    })
    fireEvent.change(screen.getByTestId("pair-jwt"), {
      target: { value: "not-a-jwt" },
    })
    await user.click(screen.getByTestId("pair-submit"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/three dot-separated parts/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects a malformed base URL before any fetch", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    fireEvent.change(await screen.findByTestId("pair-baseurl"), {
      target: { value: "ftp://nope" },
    })
    fireEvent.change(screen.getByTestId("pair-jwt"), {
      target: { value: VALID_JWT },
    })
    await user.click(screen.getByTestId("pair-submit"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/http:\/\/ or https:\/\//i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("hydrates and renders paired state when storage already has a config", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        deviceJwt: "jwt",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )

    render(<PairOnboardingClient />)

    expect(await screen.findByTestId("pair-status")).toHaveTextContent("dev-existing")
    expect(screen.getByTestId("pair-status")).toHaveTextContent("9.9.9")
  })

  it("invokes transport.call when smoke-call is pressed", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        deviceJwt: "jwt",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )

    const transportMock = (jest.requireMock("@/lib/tauri") as { transport: { call: jest.Mock } })
      .transport
    transportMock.call.mockResolvedValueOnce({ status: "ok" })

    const user = userEvent.setup()
    render(<PairOnboardingClient />)

    await user.click(await screen.findByTestId("smoke-call"))

    await waitFor(() => expect(screen.getByTestId("smoke-call-result")).toBeInTheDocument())
    expect(screen.getByTestId("smoke-call-result")).toHaveTextContent('"status": "ok"')
    expect(transportMock.call).toHaveBeenCalledWith("claude_sidecar_status")
  })

  it("Scan QR prefills the form on a successful scan", async () => {
    mockedScanQr.mockResolvedValueOnce({
      kind: "scanned",
      raw: JSON.stringify({
        baseUrl: "http://192.168.1.99:7890",
        pairJwt: "qq.qq.qq",
        v: 1,
      }),
    })

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-scan-qr"))

    await waitFor(() =>
      expect((screen.getByTestId("pair-baseurl") as HTMLInputElement).value).toBe(
        "http://192.168.1.99:7890"
      )
    )
    expect((screen.getByTestId("pair-jwt") as HTMLTextAreaElement).value).toBe("qq.qq.qq")
  })

  it("Scan QR shows an error when the QR payload isn't a cognia pairing code", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "scanned", raw: "https://example.com" })

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-scan-qr"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/cognia pairing code/i)
  })

  it("Scan QR explains permission denial without throwing", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "permission_denied" })

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-scan-qr"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/Camera permission denied/i)
  })

  it("Scan QR explains web-mode unsupported", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "unsupported" })

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-scan-qr"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(
      /only available on the mobile app/i
    )
  })

  it("Scan QR cancellation leaves the form untouched and shows no error", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "cancelled" })

    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-scan-qr"))

    // No pair-error testid should appear — give the microtask a tick first.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument()
  })

  it("clears the saved config and returns to the form when sign-out is pressed", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        deviceJwt: "jwt",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )

    const user = userEvent.setup()
    render(<PairOnboardingClient />)

    await user.click(await screen.findByTestId("pair-signout"))

    await waitFor(() => expect(screen.getByTestId("pair-baseurl")).toBeInTheDocument())
    expect(window.localStorage.getItem("cognia.companion.config.v1")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("validateBaseUrl", () => {
  it("rejects empty input", () => {
    expect(validateBaseUrl("")).toMatch(/required/i)
  })
  it("rejects malformed URLs", () => {
    expect(validateBaseUrl("not a url")).toMatch(/URL like http:/i)
  })
  it("rejects non-http(s) protocols", () => {
    expect(validateBaseUrl("ftp://host:21")).toMatch(/http:\/\/ or https:\/\//i)
  })
  it("accepts http with port", () => {
    expect(validateBaseUrl("http://192.168.1.10:7890")).toBeNull()
  })
  it("accepts https with hostname", () => {
    expect(validateBaseUrl("https://cognia.local")).toBeNull()
  })
})

describe("validatePairJwt", () => {
  it("rejects empty", () => {
    expect(validatePairJwt("")).toMatch(/required/i)
  })
  it("rejects single-segment input", () => {
    expect(validatePairJwt("notajwt")).toMatch(/three dot-separated/i)
  })
  it("rejects two-segment input", () => {
    expect(validatePairJwt("aa.bb")).toMatch(/three dot-separated/i)
  })
  it("rejects empty segments", () => {
    expect(validatePairJwt("aa..cc")).toMatch(/non-empty/i)
  })
  it("rejects non-base64url chars", () => {
    expect(validatePairJwt("aa.b!b.cc")).toMatch(/base64url/i)
  })
  it("accepts a base64url-shaped JWT", () => {
    expect(validatePairJwt("aaa.bbb.ccc")).toBeNull()
  })
  it("accepts the dash + underscore base64url alphabet", () => {
    expect(validatePairJwt("AbC-_1.AbC-_2.AbC-_3")).toBeNull()
  })
})

describe("describeHttpError", () => {
  it("hints to regenerate the pairing code on 401", () => {
    expect(describeHttpError(401, "")).toMatch(/expired/i)
  })
  it("hints at allow-list on 403", () => {
    expect(describeHttpError(403, "")).toMatch(/allow-list/i)
  })
  it("hints at server version on 404", () => {
    expect(describeHttpError(404, "")).toMatch(/v0\.2\+/i)
  })
  it("formats 5xx with the body", () => {
    expect(describeHttpError(503, "")).toMatch(/Server error \(HTTP 503\)/)
  })
  it("falls back to a generic message with body", () => {
    expect(describeHttpError(418, "i am a teapot")).toMatch(/HTTP 418/)
  })
})

describe("describeNetworkError", () => {
  it("recognises Failed to fetch", () => {
    expect(describeNetworkError(new Error("Failed to fetch"))).toMatch(/same network/i)
  })
  it("recognises ECONNREFUSED", () => {
    expect(describeNetworkError(new Error("connect ECONNREFUSED"))).toMatch(/same network/i)
  })
  it("falls through to the raw message for unknown errors", () => {
    expect(describeNetworkError(new Error("custom blowup"))).toBe("custom blowup")
  })
  it("stringifies non-Error throws", () => {
    expect(describeNetworkError("something")).toBe("something")
  })
})
