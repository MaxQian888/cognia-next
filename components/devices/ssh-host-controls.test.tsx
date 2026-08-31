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
/**
 * The shape has to be the real one: `settings.terminal`, the key `AppSettings`
 * actually declares. A mock that invents a wrapper (this one said
 * `terminalSettings` for a while) keeps passing while the component reads
 * `undefined` in production.
 */
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { terminal: { sshHosts: sshHosts ?? [] } } }),
}))
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: { getState: () => ({}) },
}))

/**
 * Whether any terminal host can answer, which is now the question the Connect
 * button asks. `isTauri` only decides HOW the connection is made: on the
 * desktop through `ssh_terminal_spawn`, everywhere else by the paired host out
 * of its own keyring.
 */
// eslint-disable-next-line no-var -- same hoisting rule as `tauri`.
var hostReachable: boolean
jest.mock("@/lib/terminal/host-settings", () => ({
  ...jest.requireActual("@/lib/terminal/host-settings"),
  terminalHostReachable: () => hostReachable,
}))

/**
 * The probe reaches Tauri through `SshTerminalSession.connect`, which is the
 * one seam it has: `useSshProbe` deliberately takes no injected runner from the
 * component, so the card cannot be wired to a probe that is not the real one.
 */
// eslint-disable-next-line no-var -- same hoisting rule as `tauri`.
var connectImpl: ((req: unknown) => Promise<unknown>) | undefined
jest.mock("@/lib/terminal/ssh-session", () => ({
  SshTerminalSession: {
    connect: (req: unknown) =>
      connectImpl
        ? connectImpl(req)
        : Promise.reject(new Error("no SSH connect stub installed for this test")),
  },
}))

import {
  getSshProbes,
  readSshProbe,
  resetSshProbesForTests,
  sshProbeTarget,
} from "@/lib/devices/ssh-probe-store"
import type { DeviceRow } from "@/lib/devices/types"

import { SshHostControls } from "./ssh-host-controls"

const PROFILE = {
  id: "s1",
  name: "prod-web-01",
  host: "10.0.4.21",
  port: 22,
  username: "deploy",
  authMethod: "privateKey" as const,
  // A key host with no path cannot produce a connect request at all, so the
  // fixture carries one. Leaving it off would make every probe assertion here
  // pass through the `invalid` branch instead of reaching a connection.
  privateKeyPath: "~/.ssh/id_ed25519",
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
  hostReachable = true
  sshHosts = [PROFILE]
  connectImpl = undefined
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
 * The gate that was wrong. `spawn_synchronized_profile` has always accepted a
 * non-local identity and connects out of the host's own keyring, so a phone or
 * a browser paired to a host can open an SSH session. What changes off the
 * desktop is who dials, and the card says so.
 */
it("connects through the paired host off the desktop, and says who is dialling", () => {
  tauri = false
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-via-host")).toBeInTheDocument()
  expect(screen.getByTestId("ssh-connect")).toBeEnabled()
})

/** SSH runs on a machine. With nothing paired there is no machine to run it. */
it("refuses when no terminal host can answer at all, and says why rather than hiding", () => {
  tauri = false
  hostReachable = false
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-no-host")).toBeInTheDocument()
  expect(screen.getByTestId("ssh-connect")).toBeDisabled()
})

/**
 * The probe stays desktop-only for a real reason rather than an inherited one:
 * it opens its own connection from this machine, and a host-mediated
 * connect-then-kill would open and close a session in the host's own tab list.
 */
it("still withholds the probe off the desktop, where it has no equivalent", () => {
  tauri = false
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-probe")).toBeDisabled()
})

/**
 * A host only knows the SSH profiles its own desktop registered, so this is a
 * routine outcome rather than a corrupt state. The bare native string does not
 * say whose list is being consulted.
 */
it("rewords a profile the host does not have, instead of the native string", async () => {
  const connect = jest
    .fn()
    .mockResolvedValue({ kind: "error", message: "ssh_profile_not_on_host:prod-web-01" })
  render(<SshHostControls row={row()} connect={connect} />)
  await userEvent.click(screen.getByTestId("ssh-connect"))
  expect(await screen.findByTestId("ssh-connect-error")).toHaveTextContent("devices.ssh.notOnHost")
  expect(screen.getByTestId("ssh-connect-error")).toHaveTextContent("prod-web-01")
})

it("blocks a password host with no saved password, and names it", () => {
  sshHosts = [{ ...PROFILE, authMethod: "password" }]
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-credential-required")).toHaveTextContent("prod-web-01")
  expect(screen.getByTestId("ssh-connect")).toBeDisabled()
})

/**
 * The third reason Connect can be dead. While every read of the SSH list
 * resolved to `undefined` this was the state of every row on screen, and the
 * component said nothing: a disabled button with no sentence beside it reads as
 * a working host you simply cannot click.
 */
it("says so when the row names a profile that is no longer saved", () => {
  sshHosts = []
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-unknown-host")).toHaveTextContent("ssh:s1")
  expect(screen.getByTestId("ssh-connect")).toBeDisabled()
})

it("shows no such warning for a host it can actually launch", () => {
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.queryByTestId("ssh-unknown-host")).not.toBeInTheDocument()
  expect(screen.getByTestId("ssh-connect")).toBeEnabled()
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

/**
 * Where it is, how it authenticates and what it goes through were all already
 * in `SshHostProfile`, and none of them reached the screen. A directory that
 * lists a machine and can say nothing about it is a link, not a console.
 */
it("states the address, the auth method and whether the secret is present", () => {
  sshHosts = [{ ...PROFILE, authMethod: "password", credentialRef: "s1" }]
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByText("deploy@10.0.4.21:22")).toBeInTheDocument()
  expect(screen.getByText("devices.ssh.auth.password")).toBeInTheDocument()
  expect(screen.getByText("devices.ssh.auth.passwordSaved")).toBeInTheDocument()
})

it("separates a stored password from a missing one, because only one of them connects", () => {
  sshHosts = [{ ...PROFILE, authMethod: "password" }]
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByText("devices.ssh.auth.passwordMissing")).toBeInTheDocument()
})

/** `agent` holds its own key material, so "no secret stored" is not a defect there. */
it("does not claim a missing secret for an agent host", () => {
  sshHosts = [{ ...PROFILE, authMethod: "agent" }]
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByText("devices.ssh.auth.agent")).toBeInTheDocument()
  expect(screen.queryByText("devices.ssh.auth.passwordMissing")).not.toBeInTheDocument()
  expect(screen.getByTestId("ssh-connect")).toBeEnabled()
})

it("calls a host with no jump host direct", () => {
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByText("devices.ssh.route.direct")).toBeInTheDocument()
  expect(screen.queryByTestId("ssh-jump-chain")).not.toBeInTheDocument()
})

/**
 * Every hop authenticates and is TOFU-verified in its own right, so the chain
 * is a list of machines being trusted. Collapsing it to "via a bastion" would
 * hide how many.
 */
it("draws every hop of a jump chain, outermost first", () => {
  const bastion = { ...PROFILE, id: "s0", name: "bastion", host: "edge.example", username: "jump" }
  sshHosts = [bastion, { ...PROFILE, jumpHostId: "s0" }]
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  const chain = screen.getByTestId("ssh-jump-chain")
  expect(chain).toHaveTextContent("jump@edge.example:22")
  expect(chain).toHaveTextContent("deploy@10.0.4.21:22")
})

/**
 * A chain that cannot be walked is not a direct connection. `resolveJumpChain`
 * returns null for a missing hop or a cycle and `buildForwardedConnectRequest`
 * refuses, so connecting direct would reach a machine the user did not name.
 */
it("refuses a broken jump chain rather than quietly connecting direct", () => {
  sshHosts = [{ ...PROFILE, jumpHostId: "gone" }]
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-chain-broken")).toBeInTheDocument()
  expect(screen.getByText("devices.ssh.route.broken")).toBeInTheDocument()
  expect(screen.getByTestId("ssh-connect")).toBeDisabled()
})

it("lists forwarding rules in both directions and marks the ones that are off", () => {
  sshHosts = [
    {
      ...PROFILE,
      localForwards: [
        { id: "l1", localPort: 8080, remoteHost: "db.internal", remotePort: 5432, enabled: true },
      ],
      remoteForwards: [
        { id: "r1", remotePort: 9000, localHost: "localhost", localPort: 3000, enabled: false },
      ],
    },
  ]
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  const forwards = screen.getByTestId("ssh-forwards")
  expect(forwards).toHaveTextContent("127.0.0.1:8080 → db.internal:5432")
  expect(forwards).toHaveTextContent("remote 127.0.0.1:9000 → localhost:3000")
  expect(forwards).toHaveTextContent("devices.ssh.forwardEnabled")
  expect(forwards).toHaveTextContent("devices.ssh.forwardDisabled")
})

it("says a host has no forwarding rules rather than showing an empty list", () => {
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.getByTestId("ssh-forwards")).toHaveTextContent("devices.ssh.forwardsNone")
})

/** No profile, no facts: the fact block must not render placeholders for a row it cannot resolve. */
it("shows no facts for a row whose profile is gone", () => {
  sshHosts = []
  render(<SshHostControls row={row()} connect={jest.fn()} />)
  expect(screen.queryByTestId("ssh-forwards")).not.toBeInTheDocument()
  expect(screen.queryByText("devices.ssh.route.direct")).not.toBeInTheDocument()
})

/**
 * The probe is the only presence signal a saved SSH host has, so the card is
 * where its cost is stated and its answer is read.
 */
describe("Test connection", () => {
  beforeEach(() => {
    resetSshProbesForTests()
  })

  afterEach(() => {
    resetSshProbesForTests()
  })

  it("never runs on its own, and says what running it costs", () => {
    render(<SshHostControls row={row()} connect={jest.fn()} />)
    expect(screen.getByTestId("ssh-probe")).toBeEnabled()
    expect(screen.getByTestId("ssh-probe-result")).toHaveTextContent("devices.ssh.probe.cost")
    expect(getSshProbes().size).toBe(0)
  })

  it("records a reachable answer and shows the fingerprint it came back with", async () => {
    connectImpl = jest.fn().mockResolvedValue({
      hostKeyStatus: "verified",
      hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz",
      kill: jest.fn().mockResolvedValue(undefined),
    })
    render(<SshHostControls row={row()} connect={jest.fn()} />)
    await userEvent.click(screen.getByTestId("ssh-probe"))
    expect(await screen.findByText("devices.ssh.probe.reachableVerified")).toBeInTheDocument()
    expect(readSshProbe("s1", sshProbeTarget(PROFILE), Date.now())?.online).toBe(true)
  })

  /**
   * `learned` means the probe itself made the trust decision. Saying so is the
   * only notice the user gets that a key was accepted on their behalf.
   */
  it("says when the probe is what trusted the host key", async () => {
    connectImpl = jest.fn().mockResolvedValue({
      hostKeyStatus: "learned",
      hostKeyFingerprint: "SHA256:zzz",
      kill: jest.fn().mockResolvedValue(undefined),
    })
    render(<SshHostControls row={row()} connect={jest.fn()} />)
    await userEvent.click(screen.getByTestId("ssh-probe"))
    expect(await screen.findByText("devices.ssh.probe.reachableLearned")).toBeInTheDocument()
  })

  it("carries the native failure rather than a generic one", async () => {
    connectImpl = jest.fn().mockRejectedValue(new Error("connection refused"))
    render(<SshHostControls row={row()} connect={jest.fn()} />)
    await userEvent.click(screen.getByTestId("ssh-probe"))
    expect(await screen.findByTestId("ssh-probe-result")).toHaveTextContent("connection refused")
    expect(readSshProbe("s1", sshProbeTarget(PROFILE), Date.now())?.online).toBe(false)
  })

  it("offers no test for a broken jump chain, which would probe the wrong machine", () => {
    sshHosts = [{ ...PROFILE, jumpHostId: "gone" }]
    render(<SshHostControls row={row()} connect={jest.fn()} />)
    expect(screen.getByTestId("ssh-probe")).toBeDisabled()
  })

  it("offers no test for a row whose profile is gone", () => {
    sshHosts = []
    render(<SshHostControls row={row()} connect={jest.fn()} />)
    expect(screen.getByTestId("ssh-probe")).toBeDisabled()
  })
})

/**
 * The failure that had no way out from here. A changed key arrives as the raw
 * `ssh_host_key_changed:{…}` JSON, and the card used to print it into the error
 * paragraph, where it told the user nothing and offered nothing.
 */
it("adjudicates a changed host key instead of printing the native payload", async () => {
  const change = JSON.stringify({
    host: "10.0.4.21",
    port: 22,
    knownFingerprint: "SHA256:old",
    presentedFingerprint: "SHA256:new",
  })
  const connect = jest
    .fn()
    .mockResolvedValue({ kind: "error", message: `ssh_host_key_changed:${change}` })
  render(<SshHostControls row={row()} connect={connect} />)
  await userEvent.click(screen.getByTestId("ssh-connect"))
  expect(await screen.findByTestId("ssh-host-key-dialog")).toBeInTheDocument()
  expect(screen.getByTestId("ssh-host-key-presented")).toHaveTextContent("SHA256:new")
  expect(screen.queryByTestId("ssh-connect-error")).not.toBeInTheDocument()
})

it("keeps its own error line for every other failure", async () => {
  const connect = jest.fn().mockResolvedValue({ kind: "error", message: "connection refused" })
  render(<SshHostControls row={row()} connect={connect} />)
  await userEvent.click(screen.getByTestId("ssh-connect"))
  expect(await screen.findByTestId("ssh-connect-error")).toHaveTextContent("connection refused")
  expect(screen.queryByTestId("ssh-host-key-dialog")).not.toBeInTheDocument()
})
