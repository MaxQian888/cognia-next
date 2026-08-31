/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

import { LoopbackDiscoveryPanel } from "./loopback-discovery-panel"

const health = { version: "1.2.3", fingerprint: "ff", advertisedPort: 27890, serverId: "s1" }

it("offers the discovered address once a host answers", async () => {
  const onUseAddress = jest.fn()
  const discover = jest
    .fn()
    .mockResolvedValue({ kind: "found", baseUrl: "http://127.0.0.1:27891", health })

  render(<LoopbackDiscoveryPanel discover={discover} onUseAddress={onUseAddress} />)
  await userEvent.click(screen.getByRole("button"))

  expect(await screen.findByTestId("loopback-found")).toBeInTheDocument()
  await userEvent.click(screen.getByRole("button", { name: /useAddress/ }))
  expect(onUseAddress).toHaveBeenCalledWith("http://127.0.0.1:27891")
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
