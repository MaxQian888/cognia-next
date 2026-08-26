/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

import type { HostProfile } from "@/lib/platform/capabilities"

import { ConnectorHostNotice, useConnectorControlReach } from "./connector-host-notice"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let profile: HostProfile = "web-standalone"
jest.mock("@/hooks/use-host-profile", () => ({
  useHostProfile: () => profile,
}))

function Probe({ requirement }: { requirement?: "connector-runtime" | "desktop-shell" }) {
  const reach = useConnectorControlReach(requirement)
  return (
    <>
      <span data-testid="available">{String(reach.available)}</span>
      <ConnectorHostNotice reach={reach} />
    </>
  )
}

it("renders nothing at all when the control can run", () => {
  profile = "desktop"
  render(<Probe />)
  expect(screen.getByTestId("available")).toHaveTextContent("true")
  expect(screen.queryByTestId("connector-host-notice")).toBeNull()
})

/**
 * The correction. A cloud companion's bots run on the paired host and the
 * Inbox beside these controls is replying through the relay, so the old
 * "adapters require the desktop app" was false — the narrower fact is that
 * these controls talk to the runtime process directly.
 */
it("tells a cloud companion the runtime is on the paired host", () => {
  profile = "cloud-companion"
  render(<Probe />)
  expect(screen.getByTestId("connector-host-notice")).toHaveAttribute("data-cause", "runs-on-host")
})

it("tells a standalone browser there is nothing running anywhere", () => {
  profile = "web-standalone"
  render(<Probe />)
  expect(screen.getByTestId("connector-host-notice")).toHaveAttribute("data-cause", "no-runtime")
})

// The cloudflared child process, personal-WeChat QR login and Matrix password
// login need the desktop app itself — a different sentence from "your bot runs
// somewhere else", which would be true and useless here.
it("separates the desktop-process controls from the runtime ones", () => {
  profile = "cloud-companion"
  render(<Probe requirement="desktop-shell" />)
  expect(screen.getByTestId("connector-host-notice")).toHaveAttribute(
    "data-cause",
    "needs-desktop-shell"
  )
})

it("always offers a next step — every block here has one", () => {
  profile = "web-standalone"
  render(<Probe />)
  expect(screen.getByTestId("connector-host-notice")).toHaveTextContent("nextStep.no-runtime")
})

it("renders a caller-supplied action", () => {
  profile = "web-standalone"
  const reach = { available: false as const, block: "no-runtime" as const }
  render(<ConnectorHostNotice reach={reach} action={<button type="button">do it</button>} />)
  expect(screen.getByRole("button", { name: "do it" })).toBeInTheDocument()
})
