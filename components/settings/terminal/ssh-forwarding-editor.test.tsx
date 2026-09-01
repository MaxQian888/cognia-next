/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

/*
  `var`, not `let`. `components/ui/button` pulls in `lib/tauri`, which calls
  `pickTransport()` at module scope, which calls this mock before a `let`
  binding has been initialized. `var` hoists as `undefined`, so the `?? true`
  below gives the module-load call the desktop answer it expects.
*/
// eslint-disable-next-line no-var
var mockTauri: boolean | undefined
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: () => mockTauri ?? true,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { SshForwardingEditor } from "./ssh-forwarding-editor"
import type { LocalForward, RemoteForward, SshHostProfile } from "@/lib/terminal/ssh-profiles"

function host(id: string, overrides: Partial<SshHostProfile> = {}): SshHostProfile {
  return {
    id,
    name: id,
    host: `${id}.example`,
    port: 22,
    username: "deploy",
    authMethod: "agent",
    ...overrides,
  }
}

function local(overrides: Partial<LocalForward> = {}): LocalForward {
  return {
    id: "lfwd-1",
    localPort: 8080,
    remoteHost: "db.internal",
    remotePort: 5432,
    enabled: true,
    ...overrides,
  }
}

function remote(overrides: Partial<RemoteForward> = {}): RemoteForward {
  return {
    id: "rfwd-1",
    remotePort: 9000,
    localHost: "localhost",
    localPort: 3000,
    enabled: false,
    ...overrides,
  }
}

function renderEditor(profile: SshHostProfile, allProfiles: SshHostProfile[] = [profile]) {
  const onChange = jest.fn()
  render(<SshForwardingEditor profile={profile} allProfiles={allProfiles} onChange={onChange} />)
  return onChange
}

describe("SshForwardingEditor", () => {
  it("adds a local rule enabled and a remote rule off", async () => {
    const user = userEvent.setup()
    const onChange = renderEditor(host("target"))

    await user.click(screen.getByTestId("ssh-local-forward-add"))
    expect(onChange).toHaveBeenLastCalledWith({
      localForwards: [expect.objectContaining({ enabled: true })],
    })

    // A remote forward opens a socket on someone else's machine pointing back
    // here, so adding one must not start it.
    await user.click(screen.getByTestId("ssh-remote-forward-add"))
    expect(onChange).toHaveBeenLastCalledWith({
      remoteForwards: [expect.objectContaining({ enabled: false })],
    })
  })

  it("carries a bind warning on the remote section that the local one does not need", () => {
    renderEditor(host("target"))
    expect(screen.getByText("remote.warning")).toBeInTheDocument()
    expect(screen.getByText("local.helper")).toBeInTheDocument()
  })

  it("edits a rule in place without disturbing its siblings", async () => {
    const user = userEvent.setup()
    const profile = host("target", {
      localForwards: [local(), local({ id: "lfwd-2", localPort: 9090 })],
    })
    const onChange = renderEditor(profile)

    await user.clear(screen.getAllByLabelText("local.localPort")[0])
    expect(onChange).toHaveBeenLastCalledWith({
      localForwards: [
        expect.objectContaining({ id: "lfwd-1", localPort: 0 }),
        expect.objectContaining({ id: "lfwd-2", localPort: 9090 }),
      ],
    })
  })

  it("removes only the rule that was asked for", async () => {
    const user = userEvent.setup()
    const profile = host("target", {
      localForwards: [local(), local({ id: "lfwd-2", localPort: 9090 })],
    })
    const onChange = renderEditor(profile)

    await user.click(screen.getByTestId("ssh-local-forward-remove-lfwd-1"))
    expect(onChange).toHaveBeenLastCalledWith({
      localForwards: [expect.objectContaining({ id: "lfwd-2" })],
    })
  })

  it("toggles a remote rule without touching the local ones", async () => {
    const user = userEvent.setup()
    const profile = host("target", { localForwards: [local()], remoteForwards: [remote()] })
    const onChange = renderEditor(profile)

    await user.click(screen.getByTestId("ssh-remote-forward-enable-rfwd-1"))
    expect(onChange).toHaveBeenLastCalledWith({
      remoteForwards: [expect.objectContaining({ id: "rfwd-1", enabled: true })],
    })
  })

  it("names the problem on the rule that has it", () => {
    const profile = host("target", {
      localForwards: [local({ remoteHost: "bad host" }), local({ id: "lfwd-2", localPort: 9090 })],
    })
    renderEditor(profile)
    expect(screen.getByTestId("ssh-local-forward-error-lfwd-1").textContent).toBe(
      "errors.host_invalid"
    )
    expect(screen.queryByTestId("ssh-local-forward-error-lfwd-2")).toBeNull()
  })

  it("flags a port claimed twice on both of the rules claiming it", () => {
    const profile = host("target", {
      localForwards: [local({ id: "a" }), local({ id: "b" })],
    })
    renderEditor(profile)
    expect(screen.getByTestId("ssh-local-forward-error-a").textContent).toBe(
      "errors.duplicate_local_port"
    )
    expect(screen.getByTestId("ssh-local-forward-error-b").textContent).toBe(
      "errors.duplicate_local_port"
    )
  })

  it("flags a duplicated server port on the remote rules too", () => {
    const profile = host("target", {
      remoteForwards: [remote({ id: "a" }), remote({ id: "b" })],
    })
    renderEditor(profile)
    expect(screen.getByTestId("ssh-remote-forward-error-a").textContent).toBe(
      "errors.duplicate_remote_port"
    )
  })

  it("clears the jump host through the sentinel rather than an empty value", async () => {
    // Radix rejects an empty `SelectItem` value, so "connect directly" needs a
    // sentinel that maps back to null on the way out.
    const user = userEvent.setup()
    const bastion = host("bastion")
    const profile = host("target", { jumpHostId: "bastion" })
    const onChange = renderEditor(profile, [bastion, profile])

    await user.click(screen.getByLabelText("jumpHost.label"))
    await user.click(await screen.findByRole("option", { name: "jumpHost.direct" }))
    expect(onChange).toHaveBeenLastCalledWith({ jumpHostId: null })
  })

  it("offers only profiles that can legally be this host's bastion", async () => {
    const user = userEvent.setup()
    const bastion = host("bastion")
    // `edge` already routes through `target`, so offering it here would make a
    // cycle the resolver would refuse at connect time.
    const edge = host("edge", { jumpHostId: "target" })
    const profile = host("target")
    renderEditor(profile, [bastion, edge, profile])

    await user.click(screen.getByLabelText("jumpHost.label"))
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent)
    expect(options).toEqual(["jumpHost.direct", "bastion"])
  })

  it("selects a bastion by profile id", async () => {
    const user = userEvent.setup()
    const bastion = host("bastion")
    const profile = host("target")
    const onChange = renderEditor(profile, [bastion, profile])

    await user.click(screen.getByLabelText("jumpHost.label"))
    await user.click(await screen.findByRole("option", { name: "bastion" }))
    expect(onChange).toHaveBeenLastCalledWith({ jumpHostId: "bastion" })
  })
})

/**
 * `buildSynchronizedSshProfiles` emits neither a jump chain nor a forwarding
 * rule, so on a paired device every field here is recorded and none of it is
 * applied. The editor stayed fully interactive and said nothing about it.
 */
describe("where these rules take effect", () => {
  afterEach(() => {
    mockTauri = undefined
  })

  it("says the desktop applies them, on a shell that does not", () => {
    mockTauri = false
    renderEditor(host("target"))
    expect(screen.getByTestId("ssh-forwarding-desktop-applies")).toBeInTheDocument()
  })

  it("stays quiet on the desktop, which does apply them", () => {
    mockTauri = true
    renderEditor(host("target"))
    expect(screen.queryByTestId("ssh-forwarding-desktop-applies")).toBeNull()
  })
})
