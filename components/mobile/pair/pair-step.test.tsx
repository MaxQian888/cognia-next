/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PairStep } from "./pair-step"
import { encodePairPayload } from "@/lib/qr/pair-payload"

const VALID_JWT = "aaa.bbb.ccc"

jest.mock("@/lib/capacitor/barcode", () => ({ scan: jest.fn() }))
jest.mock("@/lib/tauri/transport-companion", () => ({
  saveCompanionConfig: async (config: unknown) => {
    window.localStorage.setItem("cognia.companion.config.v1", JSON.stringify(config))
  },
}))
jest.mock("@/lib/signaling/v2-crypto", () => ({
  generatePersistableV2SigningIdentity: async () => ({
    privateKey: {},
    publicKey: {},
    privateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
    encodedPublicKey: "mobile-signing-key",
  }),
  buildRoomDescriptorV2: async (input: Record<string, unknown>) => ({
    v: 2,
    roomId: "room-1",
    ...input,
  }),
  importV2SigningPrivateKey: async () => ({}),
}))
const openSettingsMock = jest.fn(async () => ({ kind: "ok" as const }))
jest.mock("@/lib/capacitor/app-settings", () => ({
  openAppSettings: () => openSettingsMock(),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      scanCta: "Scan QR",
      scanning: "Scanning…",
      manualDivider: "or paste manually",
      baseUrlLabel: "Server URL",
      tokenLabel: "Pair token",
      codeLabel: "6-digit code",
      codeHint: "Find this code on the desktop PairDeviceCard, beside the QR.",
      fingerprintPinned: "Desktop identity pinned",
      fingerprintHint: "Pinned to this signing key.",
      formCardTitle: "Pair this phone",
      formCardDescription: "One-tap scan or manual paste.",
      submit: "Pair",
      submitInProgress: "Pairing…",
      errorTitle: "Pairing failed",
      "tabs.jwt": "Pair JWT",
      "tabs.code": "Pair code",
      "codeError.malformed": "Enter the 6-digit code shown on the desktop.",
      "codeError.invalid_pair_code": "Pair code must be exactly 6 digits.",
      "codeError.pair_code_not_found":
        "That code is unknown or has already been used — request a fresh one on the desktop.",
      "codeError.pair_code_expired":
        "That code has expired (5-minute lifetime). Generate a new one in desktop Settings → Companion.",
      "codeError.malformed_request":
        "The server could not parse the request. Update the app and try again.",
      "httpError.401":
        "Pairing rejected — the token may have expired (5-minute lifetime) or already been used. Generate a fresh one in desktop Settings → Companion.",
      "httpError.403":
        "Server refused the pairing request — check the desktop Companion settings for an allow-list.",
      "httpError.404":
        "Server doesn't expose /api/v1/auth/pair — confirm the desktop is running cognia v0.2+ with companion enabled.",
      "httpError.5xx": `Server error (HTTP ${(vars?.status as number) ?? "?"}). Check the desktop's logs and try again.`,
      "httpError.generic": `pair failed (HTTP ${(vars?.status as number) ?? "?"}).`,
      "scanError.notPairCode": "QR code scanned but its payload is not a cognia pairing code.",
      "scanError.permissionDenied": "Camera permission denied.",
      "scanError.openSettings": "Open Settings",
      "scanError.unsupported": "QR scan only available on mobile app.",
      "scanError.failed": `QR scan failed: ${(vars?.message as string) ?? ""}`,
      "discover.baseUrlLocked": "Server is locked",
      "discover.backToDiscover": "Back to discover",
      "web.formCardTitle": "Pair this browser",
      "web.formCardDescription": "Paste the payload or the 6-digit code.",
      "web.baseUrlLocked": "Server URL is set by this deployment",
      "web.codeHint": "Generate a code with cognia-server pair.",
      "web.pasteHint": "Paste the full cgnp2 payload or the raw pair JWT.",
      "web.storageNoticeTitle": "Credential stays in this browser",
      "web.storageNotice": "Stored in localStorage — pair from a trusted device.",
      "payloadError.invalid": "That pairing payload couldn't be decoded.",
      "payloadError.versionMismatch": `Payload version ${(vars?.got as number) ?? "?"} not understood.`,
    }
    return map[key] ?? key
  },
}))

import { scan as scanBarcode } from "@/lib/capacitor/barcode"
const mockedScanQr = scanBarcode as jest.Mock

function withSignalingV2(body: Record<string, unknown>): Record<string, unknown> {
  return {
    ...body,
    rendezvous_id: "room-1",
    room_descriptor: {
      v: 2,
      roomId: "room-1",
      roomNonce: "room-nonce",
      desktopSigningKey: "desktop-signing-key",
      mobileSigningKey: "mobile-signing-key",
      notAfter: Date.now() + 60_000,
    },
  }
}

beforeEach(() => {
  window.localStorage.clear()
  ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn()
})

afterEach(() => {
  jest.clearAllMocks()
  mockedScanQr.mockReset()
})

describe("<PairStep />", () => {
  // Without `prefilledPairJwt` the tab now starts on "code"; tests that
  // exercise the JWT path click `pair-tab-jwt` first to surface the textarea.
  it("renders the URL + JWT fields and the submit button", async () => {
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    expect(screen.getByTestId("pair-baseurl")).toBeInTheDocument()
    await user.click(screen.getByTestId("pair-tab-jwt"))
    expect(await screen.findByTestId("pair-jwt")).toBeInTheDocument()
    expect(screen.getByTestId("pair-submit")).toBeInTheDocument()
  })

  it("validates inputs before fetch", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-tab-jwt"))
    await user.click(screen.getByTestId("pair-submit"))
    expect(await screen.findByTestId("pair-error")).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects malformed JWT shape with a recoverable error", async () => {
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://test:7890" },
    })
    await user.click(screen.getByTestId("pair-tab-jwt"))
    fireEvent.change(await screen.findByTestId("pair-jwt"), { target: { value: "not-jwt" } })
    await user.click(screen.getByTestId("pair-submit"))
    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/three/i)
  })

  it("calls onPaired with the saved config on success", async () => {
    const onPaired = jest.fn()
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(withSignalingV2({
          device_id: "dev-001",
          device_jwt: "jwt.value",
          server_version: "0.1.0",
        })),
      text: () => Promise.resolve(""),
    })
    const user = userEvent.setup()
    render(<PairStep onPaired={onPaired} />)
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://192.168.1.42:7890" },
    })
    await user.click(screen.getByTestId("pair-tab-jwt"))
    fireEvent.change(await screen.findByTestId("pair-jwt"), { target: { value: VALID_JWT } })
    await user.click(screen.getByTestId("pair-submit"))
    await waitFor(() => expect(onPaired).toHaveBeenCalled())
    expect(onPaired.mock.calls[0][0]).toMatchObject({
      baseUrl: "http://192.168.1.42:7890",
      deviceJwt: "jwt.value",
      deviceId: "dev-001",
    })
  })

  it("renders the 401 hint with friendly copy", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: () => Promise.resolve({}),
      text: () => Promise.resolve(""),
    })
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://test:7890" },
    })
    await user.click(screen.getByTestId("pair-tab-jwt"))
    fireEvent.change(await screen.findByTestId("pair-jwt"), { target: { value: VALID_JWT } })
    await user.click(screen.getByTestId("pair-submit"))
    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/expired|already been used/i)
  })

  it("renders the network-down hint when fetch rejects", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockRejectedValueOnce(new Error("Failed to fetch"))
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://nope:7890" },
    })
    await user.click(screen.getByTestId("pair-tab-jwt"))
    fireEvent.change(await screen.findByTestId("pair-jwt"), { target: { value: VALID_JWT } })
    await user.click(screen.getByTestId("pair-submit"))
    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/same network/i)
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
    render(<PairStep onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-scan-qr"))
    await waitFor(() =>
      expect((screen.getByTestId("pair-baseurl") as HTMLInputElement).value).toBe(
        "http://192.168.1.99:7890"
      )
    )
    expect((screen.getByTestId("pair-jwt") as HTMLTextAreaElement).value).toBe("qq.qq.qq")
  })

  it("autoScan launches the QR scanner on mount", async () => {
    mockedScanQr.mockResolvedValueOnce({
      kind: "scanned",
      raw: JSON.stringify({ baseUrl: "http://192.168.1.50:7890", pairJwt: "zz.zz.zz", v: 1 }),
    })
    render(<PairStep onPaired={() => {}} autoScan />)
    await waitFor(() => expect(mockedScanQr).toHaveBeenCalledTimes(1))
    await waitFor(() =>
      expect((screen.getByTestId("pair-baseurl") as HTMLInputElement).value).toBe(
        "http://192.168.1.50:7890"
      )
    )
  })

  it("records the server in recents after a successful pair", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          withSignalingV2({
            device_id: "dev-rec",
            device_jwt: "jwt.rec",
            server_version: "0.2.0",
          })
        ),
      text: () => Promise.resolve(""),
    })
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://192.168.1.77:7890" },
    })
    await user.click(screen.getByTestId("pair-tab-jwt"))
    fireEvent.change(await screen.findByTestId("pair-jwt"), { target: { value: VALID_JWT } })
    await user.click(screen.getByTestId("pair-submit"))
    await waitFor(() => {
      const raw = window.localStorage.getItem("cognia.mobile.recentServers")
      expect(raw).toContain("192.168.1.77")
    })
  })

  it("Scan QR explains permission denial without throwing", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "permission_denied" })
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-scan-qr"))
    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/Camera permission denied/i)
  })

  it("Wave 4 — permission_denied surfaces an Open Settings CTA that deep-links to iOS Settings", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "permission_denied" })
    openSettingsMock.mockClear()
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-scan-qr"))
    const cta = await screen.findByTestId("pair-error-action")
    expect(cta).toHaveTextContent("Open Settings")
    await user.click(cta)
    expect(openSettingsMock).toHaveBeenCalledTimes(1)
  })

  it("Scan QR cancellation leaves the form untouched and shows no error", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "cancelled" })
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-scan-qr"))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument()
  })

  it("switches to the 6-digit code tab and rejects malformed codes locally", async () => {
    const user = userEvent.setup()
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    render(<PairStep onPaired={() => {}} />)
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://192.168.1.42:7890" },
    })
    await user.click(screen.getByTestId("pair-tab-code"))

    const codeInput = (await screen.findByTestId("pair-code-input")) as HTMLInputElement
    fireEvent.change(codeInput, { target: { value: "12abc34" } })
    expect(codeInput.value).toBe("1234")

    // Submit via fireEvent.submit on the form — user.click sometimes loses
    // the click target after a tab switch in jsdom.
    const submit = screen.getByTestId("pair-submit") as HTMLButtonElement
    const form = submit.closest("form")!
    fireEvent.submit(form)
    expect(await screen.findByTestId("pair-error")).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("posts the 6-digit code to /redeem-code and pairs on 200", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(withSignalingV2({
          device_id: "dev-100",
          device_jwt: "jwt.code",
          server_version: "0.1.0",
        })),
      text: () => Promise.resolve(""),
    })
    const onPaired = jest.fn()
    const user = userEvent.setup()
    render(<PairStep onPaired={onPaired} />)

    await user.click(screen.getByTestId("pair-tab-code"))
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://10.0.2.2:7890" },
    })
    fireEvent.change(screen.getByTestId("pair-code-input"), {
      target: { value: "654321" },
    })
    await user.click(screen.getByTestId("pair-submit"))

    await waitFor(() => expect(onPaired).toHaveBeenCalled())
    // pinnedFetch should have been called against the redeem-code URL.
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toBe("http://10.0.2.2:7890/api/v1/auth/pair/redeem-code")
    expect(onPaired.mock.calls[0][0]).toMatchObject({
      baseUrl: "http://10.0.2.2:7890",
      deviceId: "dev-100",
      deviceJwt: "jwt.code",
    })
  })

  it("maps pair_code_not_found onto the localised error copy", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({
          code: "pair_code_not_found",
          message: "pair code is unknown or already used",
        }),
      text: () =>
        Promise.resolve(
          JSON.stringify({
            code: "pair_code_not_found",
            message: "pair code is unknown or already used",
          })
        ),
    })
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)

    await user.click(screen.getByTestId("pair-tab-code"))
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://10.0.2.2:7890" },
    })
    fireEvent.change(screen.getByTestId("pair-code-input"), {
      target: { value: "654321" },
    })
    await user.click(screen.getByTestId("pair-submit"))

    expect(await screen.findByTestId("pair-error")).toHaveTextContent(
      /unknown or has already been used/i
    )
  })

  it("defaults to the code tab when no JWT is prefilled", () => {
    render(<PairStep onPaired={() => {}} />)
    // Without a prefill the 6-digit-code tab is the active default — its
    // input is mounted, and the JWT textarea is not.
    expect(screen.getByTestId("pair-code-input")).toBeInTheDocument()
    expect(screen.queryByTestId("pair-jwt")).not.toBeInTheDocument()
  })

  it("defaults to the JWT tab when prefilledPairJwt is supplied", () => {
    render(<PairStep onPaired={() => {}} prefilledPairJwt="aaa.bbb.ccc" />)
    expect(screen.getByTestId("pair-jwt")).toBeInTheDocument()
    expect(screen.queryByTestId("pair-code-input")).not.toBeInTheDocument()
  })

  it("renders a Back button when onBack is supplied and locks the baseUrl input when locked", () => {
    const onBack = jest.fn()
    render(
      <PairStep
        onPaired={() => {}}
        onBack={onBack}
        prefilledBaseUrl="http://192.168.1.10:7890"
        lockBaseUrl
      />
    )
    const input = screen.getByTestId("pair-baseurl") as HTMLInputElement
    expect(input.value).toBe("http://192.168.1.10:7890")
    expect(input).toHaveAttribute("readonly")
    fireEvent.click(screen.getByTestId("pair-back-to-discover"))
    expect(onBack).toHaveBeenCalled()
  })
})

describe("<PairStep webMode /> — plain-browser pairing (ADR-0059 C2)", () => {
  it("hides the QR scan affordances and shows the storage notice", async () => {
    const user = userEvent.setup()
    render(<PairStep webMode onPaired={() => {}} />)
    expect(screen.queryByTestId("pair-scan-qr")).not.toBeInTheDocument()
    expect(screen.queryByText("or paste manually")).not.toBeInTheDocument()
    expect(screen.getByTestId("pair-web-storage-notice")).toBeInTheDocument()
    expect(screen.getByText("Pair this browser")).toBeInTheDocument()
    // The web code hint replaces the desktop PairDeviceCard copy.
    await user.click(screen.getByTestId("pair-tab-code"))
    expect(screen.getByText(/cognia-server pair/i)).toBeInTheDocument()
  })

  it("decodes a pasted cgnp2 payload into baseUrl / JWT / fingerprint", async () => {
    const user = userEvent.setup()
    render(<PairStep webMode onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-tab-jwt"))
    const payload = encodePairPayload({
      baseUrl: "https://cloud.example.com:7890",
      pairJwt: VALID_JWT,
      version: "0.4.2",
      fingerprint: "FEEDBEEF",
    })
    fireEvent.change(await screen.findByTestId("pair-jwt"), { target: { value: payload } })
    expect((screen.getByTestId("pair-baseurl") as HTMLInputElement).value).toBe(
      "https://cloud.example.com:7890"
    )
    expect((screen.getByTestId("pair-jwt") as HTMLTextAreaElement).value).toBe(VALID_JWT)
    expect(screen.getByTestId("pair-fingerprint-pin")).toBeInTheDocument()
  })

  it("does not overwrite a locked baseUrl from the pasted payload", async () => {
    const user = userEvent.setup()
    render(
      <PairStep webMode lockBaseUrl prefilledBaseUrl="https://pinned.example.com" onPaired={() => {}} />
    )
    await user.click(screen.getByTestId("pair-tab-jwt"))
    const payload = encodePairPayload({
      baseUrl: "https://other.example.com",
      pairJwt: VALID_JWT,
      version: "0.4.2",
      fingerprint: "",
    })
    fireEvent.change(await screen.findByTestId("pair-jwt"), { target: { value: payload } })
    expect((screen.getByTestId("pair-baseurl") as HTMLInputElement).value).toBe(
      "https://pinned.example.com"
    )
    expect((screen.getByTestId("pair-jwt") as HTMLTextAreaElement).value).toBe(VALID_JWT)
  })

  it("reports an undecodable cgnp payload at submit time", async () => {
    const user = userEvent.setup()
    render(<PairStep webMode prefilledBaseUrl="http://test:7890" onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-tab-jwt"))
    fireEvent.change(await screen.findByTestId("pair-jwt"), {
      target: { value: "cgnp2|!!!not-base64url!!!" },
    })
    await user.click(screen.getByTestId("pair-submit"))
    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/couldn't be decoded/i)
  })

  it("reports a payload version mismatch with the offending version", async () => {
    const user = userEvent.setup()
    render(<PairStep webMode prefilledBaseUrl="http://test:7890" onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-tab-jwt"))
    fireEvent.change(await screen.findByTestId("pair-jwt"), {
      target: { value: "cgnp9|whatever" },
    })
    await user.click(screen.getByTestId("pair-submit"))
    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/version 9/i)
  })
})
