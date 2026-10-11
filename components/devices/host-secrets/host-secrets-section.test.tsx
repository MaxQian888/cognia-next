import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}))
jest.mock("@/lib/remote-host/host-secrets", () => ({
  ...jest.requireActual("@/lib/remote-host/host-secrets"),
  listHostSecrets: jest.fn(),
  requestHostSecretsLease: jest.fn(),
  setHostSecret: jest.fn(),
  deleteHostSecret: jest.fn(),
}))

import type { DeviceRow } from "@/lib/devices/types"
import { buildLocalHostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import type { HostSecretEntry } from "@/lib/remote-host/host-secrets"
import { HostConsentRequiredError, type HostAdminLease } from "@/lib/tauri/admin-lease"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

import { HostSecretsSection, type HostSecretsSectionDeps } from "./host-secrets-section"

const row = {
  ref: "host:mini",
  kind: "remote-host",
  label: "Mac mini",
  hostId: "mini",
} as DeviceRow
const lease: HostAdminLease = { token: "lease", operations: [], expiresAt: Date.now() + 600_000 }

const listed: HostSecretEntry[] = [
  { kind: "provider", name: "deepseek", setAt: 1_000, setBy: { deviceId: "me", label: "Laptop" } },
  {
    kind: "provider",
    name: "custom-x",
    setAt: 2_000,
    setBy: { deviceId: "phone", label: "Phone" },
  },
  { kind: "git", name: "github.com", setAt: 3_000 },
  { kind: "connector", name: "cai_1:botToken" },
]

function withHost(manifest = buildLocalHostFeatureManifest({ platform: "headless" })) {
  useRemoteHostStore.setState({
    hosts: [
      { id: "mini", label: "Mac mini", config: { deviceId: "me" }, featureManifest: manifest },
    ],
  } as never)
}

function renderSection(deps: HostSecretsSectionDeps) {
  return render(
    <HostSecretsSection row={row} deps={{ requestLease: async () => lease, ...deps }} />
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  withHost()
})

describe("HostSecretsSection", () => {
  it("lists secrets by kind with who set them, and offers removal only where it belongs", async () => {
    renderSection({ load: async () => listed })
    expect(await screen.findByTestId("host-secrets-list")).toBeInTheDocument()
    const deepseek = screen.getByTestId("host-secret-provider:deepseek")
    expect(deepseek).toHaveTextContent("DeepSeek")
    expect(deepseek).toHaveTextContent("by this device")
    expect(screen.getByTestId("host-secret-provider:custom-x")).toHaveTextContent("by Phone")
    expect(screen.getByTestId("host-secret-git:github.com")).toHaveTextContent("on Mac mini itself")
    expect(screen.getByTestId("host-secret-connector:cai_1:botToken")).toBeInTheDocument()
    expect(screen.getByText("Set and removed with their connection.")).toBeInTheDocument()
    expect(screen.getByTestId("host-secret-remove-git:github.com")).toBeInTheDocument()
    expect(screen.queryByTestId("host-secret-remove-connector:cai_1:botToken")).toBeNull()
  })

  it("seals a git token under the lease, then reads the list again", async () => {
    const load = jest.fn(async () => [] as HostSecretEntry[])
    const set = jest.fn(async () => ({ kind: "git" as const, name: "github.com" }))
    renderSection({ load, set })
    await screen.findByText("Mac mini keeps no secrets yet.")
    fireEvent.click(screen.getByTestId("host-secret-kind-git"))
    fireEvent.change(screen.getByTestId("host-secret-git-host"), {
      target: { value: "https://github.com/acme/app" },
    })
    fireEvent.change(screen.getByTestId("host-secret-value"), { target: { value: "ghp_x" } })
    fireEvent.click(screen.getByTestId("host-secret-save"))
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        "mini",
        { kind: "git", name: "https://github.com/acme/app", value: "ghp_x" },
        "lease"
      )
    )
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("github.com is sealed on Mac mini.")
    )
    expect(load).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("host-secret-value")).toHaveValue("")
  })

  it("seals a provider key chosen from the provider list", async () => {
    const user = userEvent.setup()
    const set = jest.fn(async () => ({ kind: "provider" as const, name: "deepseek" }))
    renderSection({ load: async () => [], set })
    await screen.findByText("Mac mini keeps no secrets yet.")
    expect(screen.getByTestId("host-secret-save")).toBeDisabled()
    await user.click(screen.getByTestId("host-secret-provider"))
    await user.click(await screen.findByRole("option", { name: "DeepSeek" }))
    await user.type(screen.getByTestId("host-secret-value"), "sk-1")
    await user.click(screen.getByTestId("host-secret-save"))
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        "mini",
        { kind: "provider", name: "deepseek", value: "sk-1" },
        "lease"
      )
    )
  })

  it("shows the host's approval code and seals once approved", async () => {
    const requestLease = jest
      .fn()
      .mockRejectedValueOnce(new HostConsentRequiredError("REMOTE_CONSENT_REQUIRED", "K7Q2"))
      .mockResolvedValueOnce(lease)
    const set = jest.fn(async () => ({ kind: "git" as const, name: "github.com" }))
    renderSection({ load: async () => [], requestLease, set })
    await screen.findByText("Mac mini keeps no secrets yet.")
    fireEvent.click(screen.getByTestId("host-secret-kind-git"))
    fireEvent.change(screen.getByTestId("host-secret-git-host"), {
      target: { value: "github.com" },
    })
    fireEvent.change(screen.getByTestId("host-secret-value"), { target: { value: "ghp" } })
    fireEvent.click(screen.getByTestId("host-secret-save"))
    expect(await screen.findByTestId("host-secrets-consent")).toHaveTextContent("K7Q2")
    expect(set).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("host-secrets-consent-continue"))
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1))
  })

  it("removes a provider key after saying what that stops", async () => {
    const remove = jest.fn(async () => undefined)
    renderSection({ load: async () => listed, remove })
    fireEvent.click(await screen.findByTestId("host-secret-remove-provider:deepseek"))
    expect(await screen.findByText("Remove DeepSeek?")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("host-secret-remove-confirm"))
    await waitFor(() => expect(remove).toHaveBeenCalledWith("mini", listed[0], "lease"))
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("DeepSeek was removed from Mac mini.")
    )
  })

  it("says a host without the feature is too old, and asks it nothing", async () => {
    const manifest = buildLocalHostFeatureManifest({ platform: "headless" })
    delete (manifest.features as Record<string, unknown>)["always-on.secrets"]
    withHost(manifest)
    const load = jest.fn()
    renderSection({ load })
    expect(await screen.findByTestId("host-secrets-too-old")).toHaveTextContent(
      "Mac mini is too old to keep secrets for this device."
    )
    expect(load).not.toHaveBeenCalled()
    expect(screen.queryByTestId("host-secrets-add")).toBeNull()
  })
})
