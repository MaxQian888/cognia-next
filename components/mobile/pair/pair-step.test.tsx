/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { encodePairPayload } from "@/lib/qr/pair-payload"
import { scan as scanBarcode } from "@/lib/capacitor/barcode"
import { saveCompanionConfig } from "@/lib/tauri/transport-companion"

import { PairStep } from "./pair-step"
import { registerPairPayload } from "./pair-api"

const mockReadClipboardText = jest.fn()
const mockWriteClipboardText = jest.fn()

jest.mock("@/lib/capacitor/barcode", () => ({ scan: jest.fn() }))
jest.mock("@/lib/capacitor/haptics", () => ({ notify: jest.fn() }))
jest.mock("@/lib/capacitor/app-settings", () => ({ openAppSettings: jest.fn() }))
jest.mock("@/lib/connectivity/recent-servers", () => ({ recordRecentServer: jest.fn() }))
jest.mock("@/lib/tauri/transport-companion", () => ({ saveCompanionConfig: jest.fn() }))
jest.mock("@/lib/tauri/clipboard", () => ({
  readClipboardText: () => mockReadClipboardText(),
  writeClipboardText: (value: string) => mockWriteClipboardText(value),
}))
jest.mock("./pair-api", () => ({ registerPairPayload: jest.fn() }))
jest.mock("./discover-help", () => ({ DiscoverHelp: () => <div>help</div> }))
jest.mock("@/hooks/ui/use-keyboard-insets", () => ({
  useKeyboardInsets: () => ({ keyboardHeight: 0 }),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    key === "payloadError.versionMismatch"
      ? `version ${String(vars?.got)}`
      : key === "invitationSummary.title"
        ? `Ready for ${String(vars?.host)}`
        : key,
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
  mockReadClipboardText.mockReset()
  mockWriteClipboardText.mockReset()
  mockWriteClipboardText.mockResolvedValue(undefined)
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
  register.mockResolvedValue({
    kind: "registration_error",
    message: "registration failed",
    error: new Error("registration failed"),
    baseUrl: "https://host.local:27890",
  })
  render(<PairStep onPaired={jest.fn()} />)
  await userEvent.click(screen.getByTestId("pair-scan-qr"))
  const panel = await screen.findByTestId("pair-error")
  expect(panel).toHaveAttribute("data-stage", "register")
  await userEvent.click(screen.getByTestId("pair-error-more-toggle"))
  expect(await screen.findByTestId("pair-error-detail")).toHaveTextContent("registration failed")
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

it("summarises a pasted invitation and folds the blob away behind it", async () => {
  // Empty at mount so the arrival clipboard sniff no-ops and the explicit
  // paste button is the only reader under test here.
  mockReadClipboardText.mockResolvedValue(null)
  const user = userEvent.setup()

  render(<PairStep webMode onPaired={jest.fn()} />)
  await waitFor(() => expect(mockReadClipboardText).toHaveBeenCalled())
  mockReadClipboardText.mockClear()
  mockReadClipboardText.mockResolvedValue(payload)

  await user.click(screen.getByTestId("pair-paste-clipboard"))
  expect(mockReadClipboardText).toHaveBeenCalledTimes(1)

  // What the user sees is the target, not 800 characters of base64url.
  const card = screen.getByTestId("pair-invitation-card")
  expect(card).toHaveAttribute("data-tone", "ready")
  expect(screen.getByTestId("pair-invitation-host")).toHaveTextContent("host.local:27890")

  // The blob stays mounted and editable inside the card's disclosure — it is
  // the form's controlled input, so it may be hidden but never unmounted.
  expect(screen.getByTestId("pair-payload")).toHaveValue(payload)

  await user.click(screen.getByTestId("pair-clear-payload"))
  expect(screen.getByTestId("pair-payload")).toHaveValue("")
  expect(screen.queryByTestId("pair-invitation-card")).not.toBeInTheDocument()
})

it("marks the invitation spent rather than leaving a 'ready' summary beside the error", async () => {
  // The old screen rendered the green summary from the decoded payload alone,
  // so a spent invitation showed "ready", "locked" and "spent" at once.
  register.mockResolvedValue({
    kind: "registration_error",
    message: "vault locked",
    error: Object.assign(new Error("vault locked"), { name: "VaultLockedError" }),
    baseUrl: "https://host.local:27890",
  })
  mockReadClipboardText.mockResolvedValue(null)
  render(<PairStep webMode onPaired={jest.fn()} />)
  fireEvent.change(screen.getByTestId("pair-payload"), { target: { value: payload } })
  await userEvent.click(screen.getByTestId("pair-submit"))

  await screen.findByTestId("pair-error")
  expect(screen.getByTestId("pair-invitation-card")).not.toHaveAttribute("data-tone", "ready")
})

it("fills the payload from the clipboard on arrival without submitting it", async () => {
  // The headless `cognia-server pair` command prints the invitation to a
  // terminal, so it is almost always already on the clipboard when the user
  // lands here. Filling is a convenience; submitting would act on ambient
  // content the user never pointed at this form.
  mockReadClipboardText.mockResolvedValue(`  ${payload}\n`)
  render(<PairStep webMode onPaired={jest.fn()} />)
  await waitFor(() => expect(screen.getByTestId("pair-payload")).toHaveValue(payload))
  expect(screen.getByTestId("pair-invitation-card")).toBeInTheDocument()
  expect(register).not.toHaveBeenCalled()
})

it("ignores unrelated clipboard content and a refused clipboard", async () => {
  mockReadClipboardText.mockResolvedValue("https://example.com/some-link")
  const { unmount } = render(<PairStep webMode onPaired={jest.fn()} />)
  await waitFor(() => expect(mockReadClipboardText).toHaveBeenCalled())
  expect(screen.getByTestId("pair-payload")).toHaveValue("")
  expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument()
  unmount()

  // Firefox/Safari reject `readText()` without a user gesture — stay silent.
  mockReadClipboardText.mockRejectedValue(new Error("NotAllowedError"))
  render(<PairStep webMode onPaired={jest.fn()} />)
  await waitFor(() => expect(mockReadClipboardText).toHaveBeenCalledTimes(2))
  expect(screen.getByTestId("pair-payload")).toHaveValue("")
  expect(screen.queryByTestId("pair-error")).not.toBeInTheDocument()
})

it("does not sniff the clipboard on native, or when a payload arrived with the user", async () => {
  render(<PairStep onPaired={jest.fn()} />)
  await Promise.resolve()
  expect(mockReadClipboardText).not.toHaveBeenCalled()

  render(<PairStep webMode prefilledPairPayload={payload} onPaired={jest.fn()} />)
  await Promise.resolve()
  expect(mockReadClipboardText).not.toHaveBeenCalled()
})

it("auto-submits an invitation the user arrived with", async () => {
  register.mockResolvedValue({ kind: "ok", config } as Awaited<ReturnType<typeof registerPairPayload>>)
  const onPaired = jest.fn()
  render(
    <PairStep webMode autoSubmit prefilledPairPayload={payload} onPaired={onPaired} />
  )
  await waitFor(() => expect(onPaired).toHaveBeenCalledWith(config))
  expect(register).toHaveBeenCalledTimes(1)
  expect(register).toHaveBeenCalledWith(payload)
})

it("surfaces an auto-submit failure on the manual form and does not retry", async () => {
  // A one-shot invitation is burned by the attempt; retrying would only
  // produce a second, more confusing rejection.
  register.mockResolvedValue({
    kind: "registration_error",
    message: "invitation already used",
    error: new Error("invitation already used"),
    baseUrl: "https://host.local:27890",
  })
  const onPaired = jest.fn()
  const { rerender } = render(
    <PairStep webMode autoSubmit prefilledPairPayload={payload} onPaired={onPaired} />
  )
  await waitFor(() => expect(screen.getByTestId("pair-error")).toHaveAttribute(
    "data-stage",
    "register"
  ))
  rerender(<PairStep webMode autoSubmit prefilledPairPayload={payload} onPaired={onPaired} />)
  expect(register).toHaveBeenCalledTimes(1)
  expect(onPaired).not.toHaveBeenCalled()
  expect(screen.getByTestId("pair-payload")).toHaveValue(payload)
})

it("does not auto-submit a payload the user merely pre-filled", async () => {
  render(<PairStep webMode prefilledPairPayload={payload} onPaired={jest.fn()} />)
  await Promise.resolve()
  expect(register).not.toHaveBeenCalled()
})
