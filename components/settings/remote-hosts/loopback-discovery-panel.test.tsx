/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

const mockWriteClipboardText = jest.fn()
jest.mock("@/lib/tauri/clipboard", () => ({
  writeClipboardText: (value: string) => mockWriteClipboardText(value),
}))

import { LoopbackDiscoveryPanel, loopbackPairCommand } from "./loopback-discovery-panel"

const health = { version: "1.2.3", fingerprint: "ff", advertisedPort: 27890, serverId: "s1" }

beforeEach(() => {
  mockWriteClipboardText.mockReset().mockResolvedValue(undefined)
})

/**
 * A found host's address is not something the form can pair with: pairing
 * redeems a signed `cgnp<N>|` invitation. The panel hands over the command
 * that mints one aimed at the address it found, never the bare URL.
 */
it("offers the command that mints an invitation for the host it found", async () => {
  const discover = jest
    .fn()
    .mockResolvedValue({ kind: "found", baseUrl: "http://127.0.0.1:27891", health })

  render(<LoopbackDiscoveryPanel discover={discover} />)
  await userEvent.click(screen.getByRole("button"))

  expect(await screen.findByTestId("loopback-found")).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: /useAddress/ })).not.toBeInTheDocument()
  expect(screen.getByTestId("loopback-pair-command")).toHaveTextContent(
    "cognia-server pair --device-name browser --advertise-url http://127.0.0.1:27891"
  )

  await userEvent.click(screen.getByTestId("loopback-copy-command"))
  expect(mockWriteClipboardText).toHaveBeenCalledWith(loopbackPairCommand("http://127.0.0.1:27891"))
  expect(await screen.findByRole("status")).toHaveTextContent("commandCopied")
})

it("says so when the clipboard refuses the command", async () => {
  mockWriteClipboardText.mockRejectedValue(new Error("denied"))
  const discover = jest
    .fn()
    .mockResolvedValue({ kind: "found", baseUrl: "http://127.0.0.1:27891", health })
  render(<LoopbackDiscoveryPanel discover={discover} />)
  await userEvent.click(screen.getByRole("button"))
  await userEvent.click(await screen.findByTestId("loopback-copy-command"))
  expect(await screen.findByRole("status")).toHaveTextContent("copyFailed")
})

/**
 * The reason this panel exists. "Blocked" carries the exact origin to
 * allowlist, and collapsing it into "absent" is the failure this repo keeps
 * finding: a UI stating an absence it never verified.
 */
it("names the origin to allowlist instead of reporting nothing found", async () => {
  const discover = jest.fn().mockResolvedValue({
    kind: "blocked",
    baseUrl: "http://127.0.0.1:27891",
    origin: "http://localhost:3000",
  })

  render(<LoopbackDiscoveryPanel discover={discover} />)
  await userEvent.click(screen.getByRole("button"))

  expect(await screen.findByTestId("loopback-blocked")).toHaveTextContent("http://localhost:3000")
  expect(screen.queryByTestId("loopback-absent")).toBeNull()
})

it("reports a real absence separately", async () => {
  const discover = jest.fn().mockResolvedValue({ kind: "absent" })
  render(<LoopbackDiscoveryPanel discover={discover} />)
  await userEvent.click(screen.getByRole("button"))
  expect(await screen.findByTestId("loopback-absent")).toBeInTheDocument()
})
