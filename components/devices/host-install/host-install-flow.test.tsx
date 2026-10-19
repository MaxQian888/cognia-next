/**
 * @jest-environment jsdom
 */
import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { HostInstallDeps } from "@/hooks/host-installer/use-host-install"
import type {
  InspectionView,
  InstallerFailure,
  InstallerResult,
  OpenedView,
  PairView,
  StageEventPayload,
} from "@/lib/host-installer/client"
import { encodePairPayload } from "@/lib/qr/pair-payload"
import type { SshHostProfile } from "@/lib/terminal/ssh-profiles"
import { useRemoteHostStore, type RemoteHost } from "@/stores/remote-host/remote-host-store"

import { HostInstallFlow } from "./host-install-flow"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}))
jest.mock("@/components/connectivity/pair/pair-api", () => ({ registerPairPayload: jest.fn() }))
jest.mock("@/lib/connectivity/recent-servers", () => ({ recordRecentServer: jest.fn() }))
jest.mock("@/lib/tauri/clipboard", () => ({ writeClipboardText: () => Promise.resolve() }))
const mockFileHost = jest.fn()
jest.mock("@/hooks/devices/use-register-paired-host", () => ({
  useRegisterPairedHost: () => ({ register: mockFileHost, dialog: null }),
}))

const profile: SshHostProfile = {
  id: "ssh-1",
  name: "Build box",
  host: "box.example.com",
  port: 22,
  username: "max",
  authMethod: "agent",
}

const opened: OpenedView = {
  sessionId: "hi-1",
  hostKeyStatus: "learned",
  hostKeyFingerprint: "SHA256:abc",
}

function inspection(overrides: Partial<InspectionView> = {}): InspectionView {
  return {
    inspectionId: "inst-1",
    os: "linux",
    arch: "x64",
    target: "linux-x64",
    hostname: "box",
    user: "max",
    dataDir: "/home/max/.local/share/cognia",
    serviceManager: "systemd",
    linger: true,
    glibc: "2.35",
    freeBytes: 2048,
    existing: null,
    offers: ["fresh"],
    notices: [],
    ...overrides,
  }
}

const pairView: PairView = {
  invitation: encodePairPayload({
    baseUrl: "https://box.example:27890",
    mode: "owner-invitation",
    invitation: "one-time-secret",
    hostId: "host-a",
    tenantId: "tenant-a",
    expiresAt: Date.now() + 600_000,
    serverVersion: "1.2.3",
    fingerprint: "deadbeef",
  }),
  hasRelay: false,
  expiresAtMs: Date.now() + 600_000,
}

const config = {
  baseUrl: "https://box.example:27890",
  deviceId: "device-1",
  serverVersion: "1.2.3",
  serverFingerprint: "deadbeef",
}

const ok = <T,>(value: T): InstallerResult<T> => ({ ok: true, value })
const failed = (failure: InstallerFailure) => ({ ok: false as const, failure })

let stageHandler: ((event: StageEventPayload) => void) | null = null
function makeClient(view: InspectionView = inspection()) {
  return {
    installerSshRequest: jest.fn(() => ({
      kind: "ok" as const,
      request: { host: "box" } as never,
    })),
    openSsh: jest.fn(async () => ok(opened)),
    inspectMachine: jest.fn(async () => ok(view)),
    installHost: jest.fn(async () => ok({ version: "1.2.3", dataDir: "/d" })),
    pairHost: jest.fn(async () => ok(pairView)),
    uninstallHost: jest.fn(async () => ok(null)),
    closeSession: jest.fn(async () => undefined),
    onStage: jest.fn(async (_id: string, handler: (event: StageEventPayload) => void) => {
      stageHandler = handler
      return () => undefined
    }),
  }
}

const registered = { kind: "ok" as const, config, path: "direct" }

function mount(
  client = makeClient(),
  forgetHostKey = jest.fn(async () => 1),
  registerPairPayload: () => Promise<unknown> = async () => registered
) {
  const deps: HostInstallDeps = {
    client,
    registerPairPayload: registerPairPayload as unknown as HostInstallDeps["registerPairPayload"],
    credentialStoreReady: () => true,
    deviceName: async () => "Mac",
    now: () => 7,
  }
  const onClose = jest.fn()
  render(
    <HostInstallFlow
      profile={profile}
      profiles={[profile]}
      onClose={onClose}
      deps={deps}
      forgetHostKey={forgetHostKey}
    />
  )
  return { client, onClose, forgetHostKey }
}

async function connect() {
  await userEvent.click(screen.getByTestId("host-install-connect"))
  await screen.findByTestId("host-install-ready")
}

const initialHosts = useRemoteHostStore.getState()

beforeEach(() => {
  stageHandler = null
  mockFileHost.mockReset()
  mockFileHost.mockReturnValue({ id: "host-1", label: "Build box", alwaysOn: true } as RemoteHost)
  useRemoteHostStore.setState(initialHosts, true)
})

describe("HostInstallFlow", () => {
  it("changes nothing until asked, and says what signing in costs", () => {
    const { client } = mount()
    expect(screen.getByTestId("host-install-intro")).toHaveTextContent(
      "devices.hostInstall.intro.cost"
    )
    expect(client.openSsh).not.toHaveBeenCalled()
  })

  it("shows the machine, the learned host key and the consent before installing", async () => {
    mount(makeClient(inspection({ linger: false, notices: ["linger_off"] })))
    await connect()

    expect(screen.getByTestId("host-install-host-key")).toHaveTextContent("hostKey.learned")
    expect(screen.getByText("max@box")).toBeInTheDocument()
    expect(screen.getByTestId("host-install-existing")).toHaveTextContent("existing.none")
    expect(screen.getByTestId("host-install-notice-linger_off")).toBeInTheDocument()
    const consent = screen.getByTestId("host-install-consent")
    expect(consent).toHaveTextContent("consent.steps.fresh")
    expect(consent).toHaveTextContent('"channel":"devices.hostInstall.channel.stable"')
    expect(consent).toHaveTextContent("consent.scope")
    expect(consent).toHaveTextContent("consent.disk")
    expect(screen.getByTestId("host-install-consent-linger")).toBeInTheDocument()
    expect(consent).toHaveTextContent("consent.shellEquivalence")
    // Focus moved to the step's heading, so it is what is read next.
    expect(screen.getByRole("heading", { level: 3 })).toHaveFocus()
  })

  it("installs, shows each stage and files the paired Host", async () => {
    const client = makeClient()
    let land: (() => void) | undefined
    client.installHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          land = () => resolve(ok({ version: "1.2.3", dataDir: "/d" }))
        })
    )
    mount(client)
    await connect()
    await userEvent.click(screen.getByTestId("host-install-run"))

    act(() =>
      stageHandler?.({ sessionId: "hi-1", operationId: "inst-1", stage: "upload", outcome: null })
    )
    const stages = screen.getByTestId("host-install-stages")
    expect(
      within(stages)
        .getAllByRole("listitem")
        .map((item) => item.dataset.status)
    ).toEqual(["pending", "running", "pending", "pending", "pending"])
    expect(screen.getByTestId("host-install-announce")).toHaveTextContent("stage.upload")
    expect(screen.getByText("devices.hostInstall.progress.keepOpen")).toBeInTheDocument()

    await act(async () => land?.())
    await screen.findByTestId("host-install-paired")
    expect(mockFileHost).toHaveBeenCalledWith(config, {
      label: "Build box",
      alwaysOn: true,
      connectAfter: false,
      installBinding: { kind: "ssh", profileId: "ssh-1", installedAt: 7 },
    })
    expect(screen.getByTestId("host-install-paired")).toHaveTextContent("done.pairedAlwaysOn")
    // The invitation is never on screen.
    expect(document.body.textContent).not.toContain("one-time-secret")
  })

  it("offers to switch to the Host only when it is not always-on", async () => {
    mount()
    await connect()
    expect(screen.queryByLabelText("devices.hostInstall.pairing.connectAfter")).toBeNull()
    await userEvent.click(screen.getByTestId("host-install-always-on"))
    await userEvent.click(screen.getByLabelText("devices.hostInstall.pairing.connectAfter"))
    await userEvent.click(screen.getByTestId("host-install-run"))
    await screen.findByTestId("host-install-paired")
    expect(mockFileHost).toHaveBeenCalledWith(
      config,
      expect.objectContaining({ alwaysOn: false, connectAfter: true })
    )
  })

  it("asks to inspect again after an unknown outcome, never to retry", async () => {
    const client = makeClient()
    client.installHost.mockResolvedValueOnce(
      failed({ kind: "unknown", stage: "upload", message: "dropped" })
    )
    mount(client)
    await connect()
    await userEvent.click(screen.getByTestId("host-install-run"))
    const panel = await screen.findByTestId("host-install-failed")
    expect(panel.dataset.next).toBe("reinspect")
    expect(screen.getByTestId("host-install-failure")).toHaveTextContent("failure.unknown")
    expect(screen.getByTestId("host-install-failure")).toHaveTextContent("stage.upload")
    expect(screen.getByTestId("host-install-next")).toHaveTextContent("next.reinspect")

    await userEvent.click(screen.getByTestId("host-install-next"))
    await screen.findByTestId("host-install-ready")
    expect(client.inspectMachine).toHaveBeenCalledTimes(2)
    expect(client.installHost).toHaveBeenCalledTimes(1)
  })

  it("names an unsupported machine and offers nothing to repeat", async () => {
    const client = makeClient()
    client.inspectMachine.mockResolvedValueOnce(
      failed({
        kind: "unsupported",
        reason: { cause: "glibc_too_old", found: "2.31", baseline: "2.35" },
        message: "glibc 2.31",
      })
    )
    const { onClose } = mount(client)
    await userEvent.click(screen.getByTestId("host-install-connect"))
    const failure = await screen.findByTestId("host-install-failure")
    expect(failure).toHaveTextContent(
      'failure.unsupported.glibcTooOld:{"found":"2.31","baseline":"2.35"}'
    )
    await userEvent.click(screen.getByText("devices.hostInstall.failure.detail"))
    expect(screen.getByText("glibc 2.31")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("host-install-next"))
    expect(onClose).toHaveBeenCalled()
  })

  it("re-trusts a changed host key only after review, then dials again", async () => {
    const client = makeClient()
    client.openSsh.mockResolvedValueOnce(
      failed({
        kind: "host_key_changed",
        change: {
          host: "box.example.com",
          port: 22,
          knownFingerprint: "SHA256:old",
          presentedFingerprint: "SHA256:new",
        },
      })
    )
    const { forgetHostKey } = mount(client)
    await userEvent.click(screen.getByTestId("host-install-connect"))
    await screen.findByTestId("host-install-failed")
    expect(screen.getByTestId("host-install-failed").dataset.next).toBe("reconnect")
    expect(forgetHostKey).not.toHaveBeenCalled()

    await userEvent.click(screen.getByTestId("host-install-review-key"))
    const dialog = await screen.findByRole("alertdialog")
    const buttons = within(dialog).getAllByRole("button")
    await userEvent.click(buttons[buttons.length - 1])
    await waitFor(() =>
      expect(forgetHostKey).toHaveBeenCalledWith("box.example.com", 22, "SHA256:old")
    )
    await screen.findByTestId("host-install-ready")
    expect(client.openSsh).toHaveBeenCalledTimes(2)
  })

  it("deletes data on uninstall only once the machine's name is typed", async () => {
    const client = makeClient(inspection({ offers: ["re_pair", "uninstall"] }))
    useRemoteHostStore.setState({
      hosts: [
        {
          id: "host-1",
          label: "Build box",
          installBinding: { kind: "ssh", profileId: "ssh-1", installedAt: 1 },
        } as RemoteHost,
      ],
    })
    const removeHost = jest.fn()
    useRemoteHostStore.setState({ removeHost })
    mount(client)
    await connect()
    await userEvent.click(screen.getByTestId("host-install-plan-uninstall"))
    expect(screen.getByTestId("host-install-consent")).toHaveTextContent("consent.steps.uninstall")
    expect(screen.queryByTestId("host-install-pairing")).toBeNull()

    await userEvent.click(screen.getByTestId("host-install-delete-data"))
    const run = screen.getByTestId("host-install-run")
    expect(run).toBeDisabled()
    await userEvent.type(screen.getByTestId("host-install-typed-name"), "bo")
    expect(run).toBeDisabled()
    await userEvent.type(screen.getByTestId("host-install-typed-name"), "x")
    expect(run).toBeEnabled()
    await userEvent.click(run)

    await screen.findByTestId("host-install-uninstalled")
    expect(client.uninstallHost).toHaveBeenCalledWith({
      sessionId: "hi-1",
      inspectionId: "inst-1",
      deleteDataConfirmation: "box",
    })
    expect(screen.getByTestId("host-install-uninstalled")).toHaveTextContent(
      "done.uninstalledDataDeleted"
    )
    await userEvent.click(screen.getByTestId("host-install-forget"))
    expect(removeHost).toHaveBeenCalledWith("host-1")
  })

  it("lists the offers in a fixed order and re-pairs without installing", async () => {
    const client = makeClient(inspection({ offers: ["uninstall", "re_pair", "repair"] }))
    mount(client)
    await connect()
    expect(screen.getAllByRole("radio").map((radio) => radio.getAttribute("value"))).toEqual([
      "repair",
      "re_pair",
      "uninstall",
    ])
    await userEvent.click(screen.getByTestId("host-install-plan-re_pair"))
    await userEvent.click(screen.getByTestId("host-install-run"))
    await screen.findByTestId("host-install-paired")
    expect(client.installHost).not.toHaveBeenCalled()
  })

  it("explains a profile that cannot be dialled and links to its editor", async () => {
    const client = makeClient()
    client.installerSshRequest.mockReturnValueOnce({
      kind: "invalid",
      reason: "jumpChain",
    } as never)
    mount(client)
    await userEvent.click(screen.getByTestId("host-install-connect"))
    const alert = await screen.findByTestId("host-install-invalid-profile")
    expect(alert).toHaveTextContent("devices.ssh.probe.invalidReason.jumpChain")
    expect(within(alert).getByRole("link")).toHaveAttribute(
      "href",
      expect.stringContaining("ssh-1")
    )
  })

  it("says when the Host cannot reach the relay to mint an invitation", async () => {
    const client = makeClient()
    client.pairHost.mockResolvedValueOnce(
      failed({ kind: "relay_unavailable", message: "no relay" })
    )
    mount(client)
    await connect()
    await userEvent.click(screen.getByTestId("host-install-run"))
    const failure = await screen.findByTestId("host-install-failure")
    expect(failure).toHaveTextContent("failure.relayUnavailable")
    expect(screen.getByTestId("host-install-failed").dataset.next).toBe("reinspect")
  })

  it("shows the pairing taxonomy when the Host refuses the invitation", async () => {
    mount(makeClient(), undefined, async () => ({
      kind: "registration_error",
      message: "403",
      error: new Error("invitation already used"),
      baseUrl: config.baseUrl,
    }))
    await connect()
    await userEvent.click(screen.getByTestId("host-install-run"))
    expect(await screen.findByTestId("pair-error")).toBeInTheDocument()
    expect(screen.getByTestId("host-install-failed").dataset.next).toBe("reinspect")
    expect(
      within(screen.getByTestId("host-install-stages")).getAllByRole("listitem").at(-1)?.dataset
        .status
    ).toBe("failed")
    expect(mockFileHost).not.toHaveBeenCalled()
  })
})
