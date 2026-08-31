/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

/**
 * `var`, not `let`: `jest.mock` factories are hoisted above this body, and
 * `components/ui/alert` pulls in `lib/tauri`, which calls `isTauri()` at
 * module-init time. A `let` is still in its temporal dead zone at that point
 * and reading it throws.
 */
// eslint-disable-next-line no-var -- hoisting is the point; see above.
var tauri: boolean | undefined
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => tauri ?? true,
}))

// eslint-disable-next-line no-var -- same hoisting rule as `tauri`.
var sshHosts: unknown[] | undefined
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { terminalSettings: { sshHosts: sshHosts ?? [] } } }),
}))
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({}) },
}))

import type { DeviceRow } from "@/lib/devices/types"

import { SshHostControls } from "./ssh-host-controls"

const PROFILE = {
  id: "s1",
  name: "prod-web-01",
  host: "10.0.4.21",
  port: 22,
  username: "deploy",
  authMethod: "privateKey" as const,
}

function row(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    ref: "ssh:s1",
    kind: "ssh-host",
    label: "prod-web-01",
    isSelf: false,
    adminState: "unknown",
    reachability: "unknown",
    liveness: { online: false, lastSeenAt: 0, source: "manifest" },
    capabilities: [],
    capabilityReportMissing: true,
    grants: [],
    placement: { provides: [], activeUnits: 0, maxUnits: 0 },
    runtime: {
      sandbox: { support: "unsupported", connections: [] },
      shellTiers: [],
      workspaces: { support: "unsupported" },
      isRoutingTarget: false,
    },
    ...overrides,
  }
}

beforeEach(() => {
  tauri = true
  sshHosts = [PROFILE]
})

it("opens a shell through the shared dock launcher", async () => {
  const connect = jest.fn().mockResolvedValue({ kind: "connected", sessionId: "t1" })
  render(<SshHostControls row={row()} connect={connect} />)
  await userEvent.click(screen.getByTestId("ssh-connect"))
  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({
      profile: PROFILE,
      // The whole set travels: a jump host is stored as a profile id, so
      // sending only the target connects a bastion-backed host direct.
      allProfiles: [PROFILE],
    })
  )
})

/**
 * `ssh_terminal_*` is `target: "client"` with `capability: client.local`, and
 * the Rust arm refuses a non-local identity. Rendering the button disabled with
 * the reason keeps "not supported here" apart from "you have no SSH hosts".
 */
it("refuses to connect off the desktop, and says why rather than hiding", () => {
  tauri = false
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-local-only")).toBeInTheDocument()
  expect(screen.getByTestId("ssh-connect")).toBeDisabled()
})

it("blocks a password host with no saved password, and names it", () => {
  sshHosts = [{ ...PROFILE, authMethod: "password" }]
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-credential-required")).toHaveTextContent("prod-web-01")
  expect(screen.getByTestId("ssh-connect")).toBeDisabled()
})

it("surfaces a connection failure instead of failing silently", async () => {
  const connect = jest.fn().mockResolvedValue({ kind: "error", message: "host key changed" })
  render(<SshHostControls row={row()} connect={connect} />)
  await userEvent.click(screen.getByTestId("ssh-connect"))
  expect(await screen.findByTestId("ssh-connect-error")).toHaveTextContent("host key changed")
})

/** Editing stays in Settings: two forms for one profile is two places to change a port. */
it("sends editing back to the Settings editor", () => {
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  // `asChild` merges the Button into the Link, so the testid IS the anchor.
  expect(screen.getByTestId("ssh-edit")).toHaveAttribute("href", "/settings?section=terminal")
})

it("renders nothing for a row that is not an SSH host", () => {
  const { container } = render(
    <SshHostControls row={row({ kind: "remote-host" })} connect={jest.fn()} />
  )
  expect(container).toBeEmptyDOMElement()
})
