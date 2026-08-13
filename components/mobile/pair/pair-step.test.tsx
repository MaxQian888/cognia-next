/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { encodePairPayload } from "@/lib/qr/pair-payload"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { saveCompanionConfig } from "@/lib/tauri/transport-companion"

import { PairStep } from "./pair-step"
import { registerPairPayload } from "./pair-api"

jest.mock("@/lib/capacitor/barcode", () => ({ scan: jest.fn() }))
jest.mock("@/lib/capacitor/haptics", () => ({ notify: jest.fn() }))
jest.mock("@/lib/capacitor/app-settings", () => ({ openAppSettings: jest.fn() }))
jest.mock("@/lib/connectivity/recent-servers", () => ({ recordRecentServer: jest.fn() }))
jest.mock("@/lib/tauri/transport-companion", () => ({ saveCompanionConfig: jest.fn() }))
jest.mock("./pair-api", () => ({ registerPairPayload: jest.fn() }))
jest.mock("./discover-help", () => ({ DiscoverHelp: () => <div>help</div> }))
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardInsets: () => ({ keyboardHeight: 0 }),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    key === "payloadError.versionMismatch" ? `version ${String(vars?.got)}` : key,
}))

const register = registerPairPayload as jest.MockedFunction<typeof registerPairPayload>
const scan = scanBarcode as jest.MockedFunction<typeof scanBarcode>
const save = saveCompanionConfig as jest.MockedFunction<typeof saveCompanionConfig>
const payload = encodePairPayload({
  baseUrl: "https://host.local:27890",
  mode: "owner-invitation",
  invitation: "invite",
  hostId: "host-1",
  tenantId: "tenant-1",
  expiresAt: Date.now() + 60_000,
  serverVersion: "1.0.0",
  fingerprint: "ab".repeat(32),
})
const config = {
  baseUrl: "https://host.local:27890",
  deviceId: "device-1",
  devicePrivateKeyJwk: { kty: "EC", d: "secret" },
  deviceKeyThumbprint: "thumbprint",
  serverVersion: "1.0.0",
}

beforeEach(() => {
  register.mockReset()
  scan.mockReset()
  save.mockReset()
})

it("shows only the canonical invitation payload surface", () => {
  render(<PairStep onPaired={jest.fn()} />)
  expect(screen.getByTestId("pair-payload")).toHaveAttribute("placeholder", "payloadPlaceholder")
  expect(screen.queryByTestId("pair-tab-code")).not.toBeInTheDocument()
  expect(screen.queryByTestId("pair-jwt")).not.toBeInTheDocument()
})

it("registers, persists, and reports a valid pairing", async () => {
  const onPaired = jest.fn()
  register.mockResolvedValue({ kind: "ok", config })
  render(<PairStep prefilledPairPayload={payload} onPaired={onPaired} />)
  await userEvent.click(screen.getByTestId("pair-submit"))
  await waitFor(() => expect(register).toHaveBeenCalledWith(payload))
  expect(save).toHaveBeenCalledWith(config)
  expect(onPaired).toHaveBeenCalledWith(config)
})

it("uses the caller's activation transaction when adding another Host", async () => {
  const persistPairing = jest.fn().mockResolvedValue(undefined)
  register.mockResolvedValue({ kind: "ok", config })
  render(
    <PairStep
      prefilledPairPayload={payload}
      persistPairing={persistPairing}
      onPaired={jest.fn()}
    />
  )
  await userEvent.click(screen.getByTestId("pair-submit"))

  await waitFor(() => expect(persistPairing).toHaveBeenCalledWith(config))
  expect(save).not.toHaveBeenCalled()
})

it("surfaces secure persistence failures without reporting the device paired", async () => {
  const onPaired = jest.fn()
  register.mockResolvedValue({ kind: "ok", config })
  save.mockRejectedValue(new Error("Vault write failed"))
  render(<PairStep prefilledPairPayload={payload} onPaired={onPaired} />)
  await userEvent.click(screen.getByTestId("pair-submit"))
  expect(await screen.findByTestId("pair-error")).toHaveTextContent("persistenceError")
  expect(onPaired).not.toHaveBeenCalled()
})

it("rejects old payload versions before registration", async () => {
  render(<PairStep prefilledPairPayload="cgnp2|legacy" onPaired={jest.fn()} />)
  await userEvent.click(screen.getByTestId("pair-submit"))
  expect(await screen.findByTestId("pair-error")).toHaveTextContent("version 2")
  expect(register).not.toHaveBeenCalled()
})

it("registers and persists a scanned cgnp3 payload in one step", async () => {
  const onPaired = jest.fn()
  scan.mockResolvedValue({ kind: "scanned", raw: payload })
  register.mockResolvedValue({ kind: "ok", config })
  render(<PairStep onPaired={onPaired} />)
  await userEvent.click(screen.getByTestId("pair-scan-qr"))
  await waitFor(() => expect(onPaired).toHaveBeenCalledWith(config))
  expect(register).toHaveBeenCalledWith(payload)
  expect(save).toHaveBeenCalledWith(config)
})

it("keeps a scanned payload editable when registration fails", async () => {
  scan.mockResolvedValue({ kind: "scanned", raw: payload })
  register.mockResolvedValue({ kind: "registration_error", message: "registration failed" })
  render(<PairStep onPaired={jest.fn()} />)
  await userEvent.click(screen.getByTestId("pair-scan-qr"))
  expect(await screen.findByTestId("pair-error")).toHaveTextContent("registration failed")
  expect(screen.getByTestId("pair-payload")).toHaveValue(payload)
})

it.each([
  [{ kind: "permission_denied" as const }, "scanError.permissionDenied"],
  [{ kind: "unsupported" as const }, "scanError.unsupported"],
  [{ kind: "error" as const, message: "camera failed" }, "scanError.failed"],
])("surfaces scanner result %o", async (result, message) => {
  scan.mockResolvedValue(result)
  render(<PairStep onPaired={jest.fn()} />)
  await userEvent.click(screen.getByTestId("pair-scan-qr"))
  expect(await screen.findByTestId("pair-error")).toHaveTextContent(message)
})

it("returns to idle when scanning is cancelled", async () => {
  scan.mockResolvedValue({ kind: "cancelled" })
  render(<PairStep onPaired={jest.fn()} />)
  await userEvent.click(screen.getByTestId("pair-scan-qr"))
  await waitFor(() => expect(screen.getByTestId("pair-scan-qr")).toBeEnabled())
  expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument()
})

it("exposes a stable back affordance on native pair flows", () => {
  render(<PairStep onPaired={jest.fn()} onBack={jest.fn()} />)
  expect(screen.getByTestId("pair-back-to-discover")).toBeInTheDocument()
})

it("does not expose the camera action in web mode", () => {
  render(<PairStep webMode onPaired={jest.fn()} />)
  expect(screen.queryByTestId("pair-scan-qr")).not.toBeInTheDocument()
  fireEvent.change(screen.getByTestId("pair-payload"), { target: { value: payload } })
})
