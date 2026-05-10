/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { PairStep } from "./pair-step"

const VALID_JWT = "aaa.bbb.ccc"

jest.mock("@/lib/capacitor/barcode", () => ({ scan: jest.fn() }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      scanCta: "Scan QR",
      manualDivider: "or paste manually",
      baseUrlLabel: "Server URL",
      tokenLabel: "Pair token",
      fingerprintPinned: "Desktop identity pinned",
      fingerprintHint: "Pinned to this signing key.",
      formCardTitle: "Pair this phone",
      formCardDescription: "One-tap scan or manual paste.",
      submit: "Pair",
      submitInProgress: "Pairing…",
      errorTitle: "Pairing failed",
      "scanError.notPairCode": "QR code scanned but its payload is not a cognia pairing code.",
      "scanError.permissionDenied": "Camera permission denied.",
      "scanError.unsupported": "QR scan only available on mobile app.",
      "scanError.failed": `QR scan failed: ${(vars?.message as string) ?? ""}`,
      "discover.baseUrlLocked": "Server is locked",
      "discover.backToDiscover": "Back to discover",
    }
    return map[key] ?? key
  },
}))

import { scan as scanBarcode } from "@/lib/capacitor/barcode"
const mockedScanQr = scanBarcode as jest.Mock

beforeEach(() => {
  window.localStorage.clear()
  ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn()
})

afterEach(() => {
  jest.clearAllMocks()
  mockedScanQr.mockReset()
})

describe("<PairStep />", () => {
  it("renders the URL + JWT fields and the submit button", () => {
    render(<PairStep onPaired={() => {}} />)
    expect(screen.getByTestId("pair-baseurl")).toBeInTheDocument()
    expect(screen.getByTestId("pair-jwt")).toBeInTheDocument()
    expect(screen.getByTestId("pair-submit")).toBeInTheDocument()
  })

  it("validates inputs before fetch", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
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
    fireEvent.change(screen.getByTestId("pair-jwt"), { target: { value: "not-jwt" } })
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
        Promise.resolve({
          device_id: "dev-001",
          device_jwt: "jwt.value",
          server_version: "0.1.0",
        }),
      text: () => Promise.resolve(""),
    })
    const user = userEvent.setup()
    render(<PairStep onPaired={onPaired} />)
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://192.168.1.42:7890" },
    })
    fireEvent.change(screen.getByTestId("pair-jwt"), { target: { value: VALID_JWT } })
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
    fireEvent.change(screen.getByTestId("pair-jwt"), { target: { value: VALID_JWT } })
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
    fireEvent.change(screen.getByTestId("pair-jwt"), { target: { value: VALID_JWT } })
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

  it("Scan QR explains permission denial without throwing", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "permission_denied" })
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-scan-qr"))
    expect(await screen.findByTestId("pair-error")).toHaveTextContent(/Camera permission denied/i)
  })

  it("Scan QR cancellation leaves the form untouched and shows no error", async () => {
    mockedScanQr.mockResolvedValueOnce({ kind: "cancelled" })
    const user = userEvent.setup()
    render(<PairStep onPaired={() => {}} />)
    await user.click(screen.getByTestId("pair-scan-qr"))
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument()
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
