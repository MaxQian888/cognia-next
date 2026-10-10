import { act, fireEvent, render, screen, within } from "@testing-library/react"

import en from "@/i18n/messages/en/settings/remoteSandboxes.json"
import type {
  RemoteSandboxesActions,
  RemoteSandboxesState,
  RemoteSandboxesWriteResult,
} from "@/hooks/sandbox/use-remote-sandboxes"
import type { RemoteSandboxesView, SandboxProviderConfig } from "@/types/sandbox/remote-sandboxes"

// The hook has its own suite; here it is a double the test drives.
let hookState: RemoteSandboxesState
const ok = async (): Promise<RemoteSandboxesWriteResult> => ({ ok: true })
const reload = jest.fn(async () => {})
const saveProvider = jest.fn(ok)
const removeProvider = jest.fn(ok)
const setDefaultProvider = jest.fn(ok)
const saveRegistryAllowlist = jest.fn(ok)

jest.mock("@/hooks/sandbox/use-remote-sandboxes", () => ({
  ...jest.requireActual("@/hooks/sandbox/use-remote-sandboxes"),
  useRemoteSandboxes: (): RemoteSandboxesState & RemoteSandboxesActions => ({
    ...hookState,
    reload,
    saveProvider,
    removeProvider,
    setDefaultProvider,
    saveRegistryAllowlist,
  }),
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args) } }))

import { RemoteSandboxesSection } from "./remote-sandboxes-section"

const e2b = (id: string, overrides: Partial<SandboxProviderConfig> = {}): SandboxProviderConfig =>
  ({
    id,
    kind: "e2b",
    credential: { secretId: `remote-sandbox:${id}` },
    limits: { maxConcurrent: 4, maxLifetimeSecs: 7200, idleTimeoutSecs: 600 },
    settings: { apiUrl: "https://api.e2b.app", domain: "e2b.app" },
    ...overrides,
  }) as SandboxProviderConfig

function view(overrides: Partial<RemoteSandboxesView> = {}): RemoteSandboxesView {
  return {
    settings: { version: 1, providers: { version: 1, providers: [] }, registryAllowlist: [] },
    availability: "no_providers",
    bundle: {
      registry: "ghcr.io",
      repository: "cognia/agent-bundle",
      digest: `sha256:${"b".repeat(64)}`,
      releaseTag: "v1.4.0",
    },
    storedSecretIds: [],
    restartRequired: false,
    installError: null,
    ...overrides,
  }
}

function withProviders(
  providers: SandboxProviderConfig[],
  extra: Partial<RemoteSandboxesView> & { defaultProviderId?: string } = {}
): RemoteSandboxesView {
  const { defaultProviderId, ...rest } = extra
  return view({
    availability: "active",
    settings: {
      version: 1,
      providers: { version: 1, providers, ...(defaultProviderId ? { defaultProviderId } : {}) },
      registryAllowlist: [],
    },
    ...rest,
  })
}

function renderReady(next: RemoteSandboxesView) {
  hookState = { status: "ready", view: next, busy: false }
  return render(<RemoteSandboxesSection />)
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("RemoteSandboxesSection", () => {
  it("says it is loading before the first read", () => {
    hookState = { status: "loading", busy: false }
    render(<RemoteSandboxesSection />)
    expect(screen.getByText(en.loading)).toBeInTheDocument()
    expect(screen.queryByText(en.providers.title)).not.toBeInTheDocument()
  })

  it("says why the settings could not be read", () => {
    hookState = {
      status: "failed",
      busy: false,
      loadProblem: { code: "remote_sandboxes_unreadable", message: "bad json" },
    }
    render(<RemoteSandboxesSection />)
    expect(screen.getByText(en.failed)).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent("bad json")
  })

  it("says nothing runs remotely with no provider", () => {
    renderReady(view())
    expect(screen.getByTestId("remote-sandboxes-availability")).toHaveTextContent(
      en.availability.noProviders
    )
    expect(screen.getByText(en.providers.empty)).toBeInTheDocument()
  })

  // Working Rule 7: a build with no pinned agent bundle runs nothing remotely.
  it("labels an unpinned build as not running remote sandboxes, and keeps the providers editable", () => {
    renderReady(withProviders([e2b("e2b")], { availability: "bundle_unpinned", bundle: null }))
    const banner = screen.getByTestId("remote-sandboxes-bundle-unpinned")
    expect(banner).toHaveAttribute("data-dormant", "bundle-unpinned")
    expect(banner).toHaveTextContent(en.availability.bundleUnpinned)
    expect(screen.queryByTestId("remote-sandboxes-availability")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: en.providers.add })).toBeEnabled()
  })

  it("lists providers with their kind, limits, credential and the bundle", () => {
    renderReady(
      withProviders(
        [
          e2b("e2b", { label: "E2B cloud" }),
          e2b("other", { credential: { env: "E2B_KEY" } }),
          {
            id: "cluster",
            kind: "kubernetes",
            settings: { connection: "inCluster", namespace: "cognia" },
          },
        ],
        { storedSecretIds: [], defaultProviderId: "e2b" }
      )
    )
    expect(screen.getByTestId("remote-sandboxes-availability")).toHaveTextContent(
      en.availability.bundle.replace("{tag}", "v1.4.0")
    )
    const first = screen.getByTestId("remote-sandbox-provider-e2b")
    expect(first).toHaveTextContent("E2B cloud")
    expect(first).toHaveTextContent(en.providers.default)
    expect(first).toHaveTextContent(en.providers.credential.missing)
    expect(first).toHaveTextContent("Up to 4 at once · 120 min lifetime · idle after 10 min")
    expect(screen.getByTestId("remote-sandbox-provider-other")).toHaveTextContent(
      en.providers.credential.env.replace("{name}", "E2B_KEY")
    )
    const cluster = screen.getByTestId("remote-sandbox-provider-cluster")
    expect(cluster).toHaveTextContent(en.providers.kind.kubernetes)
    expect(cluster).toHaveTextContent(en.providers.credential.none)
  })

  it("marks a single provider as the default without a pointer", () => {
    renderReady(withProviders([e2b("e2b")], { storedSecretIds: ["remote-sandbox:e2b"] }))
    const row = screen.getByTestId("remote-sandbox-provider-e2b")
    expect(row).toHaveTextContent(en.providers.onlyDefault)
    expect(row).toHaveTextContent(en.providers.credential.stored)
    expect(within(row).queryByRole("button", { name: en.providers.makeDefault })).toBeNull()
  })

  it("makes and clears the default", async () => {
    renderReady(withProviders([e2b("a"), e2b("b")], { defaultProviderId: "a" }))
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("remote-sandbox-provider-b")).getByRole("button", {
          name: en.providers.makeDefault,
        })
      )
    })
    expect(setDefaultProvider).toHaveBeenCalledWith("b")
    await act(async () => {
      fireEvent.click(
        within(screen.getByTestId("remote-sandbox-provider-a")).getByRole("button", {
          name: en.providers.clearDefault,
        })
      )
    })
    expect(setDefaultProvider).toHaveBeenLastCalledWith(undefined)
  })

  it("says changes apply at the next start, and why the last start refused them", () => {
    renderReady(
      withProviders([e2b("e2b")], {
        restartRequired: true,
        installError: "provider e2b: credential remote-sandbox:e2b is not stored",
      })
    )
    expect(screen.getByTestId("remote-sandboxes-restart")).toHaveTextContent(en.restart.title)
    expect(screen.getByTestId("remote-sandboxes-install-error")).toHaveTextContent(
      "credential remote-sandbox:e2b is not stored"
    )
  })

  it("removes a provider after confirming", async () => {
    renderReady(withProviders([e2b("e2b", { label: "E2B cloud" })]))
    fireEvent.click(
      within(screen.getByTestId("remote-sandbox-provider-e2b")).getByRole("button", {
        name: en.providers.remove,
      })
    )
    expect(
      screen.getByText(en.removeDialog.title.replace("{label}", "E2B cloud"))
    ).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.removeDialog.confirm }))
    })
    expect(removeProvider).toHaveBeenCalledWith("e2b")
    expect(toastSuccess).toHaveBeenCalledWith(en.removed.replace("{label}", "E2B cloud"))
  })

  it("shows a refused removal under the list", async () => {
    removeProvider.mockResolvedValueOnce({
      ok: false,
      problem: { code: "remote_sandboxes_unwritable", message: "disk full" },
    })
    renderReady(withProviders([e2b("e2b")]))
    fireEvent.click(screen.getByRole("button", { name: en.providers.remove }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.removeDialog.confirm }))
    })
    expect(screen.getByRole("alert")).toHaveTextContent("disk full")
  })

  it("opens the editor to add and to edit", () => {
    renderReady(withProviders([e2b("e2b")]))
    fireEvent.click(screen.getByRole("button", { name: en.providers.add }))
    expect(screen.getByText(en.editor.createTitle)).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: en.editor.cancel }))
    fireEvent.click(screen.getByRole("button", { name: en.providers.edit }))
    expect(screen.getByText(en.editor.editTitle.replace("{label}", "e2b"))).toBeInTheDocument()
  })

  it("reloads on request", () => {
    renderReady(view())
    fireEvent.click(screen.getByRole("button", { name: en.reload }))
    expect(reload).toHaveBeenCalled()
  })

  it("hands the allowlist editor the saved rules", () => {
    renderReady(
      view({
        settings: {
          version: 1,
          providers: { version: 1, providers: [] },
          registryAllowlist: [{ registry: "ghcr.io", repositoryPrefix: "acme" }],
        },
      })
    )
    const registries = screen.getByTestId("remote-sandbox-registries")
    expect(within(registries).getByLabelText(en.registries.registry)).toHaveValue("ghcr.io")
  })

  describe("what the running pool reports", () => {
    const live = {
      id: "e2b",
      driver: "e2b",
      remote: true,
      isDefault: true,
      reachable: true,
      availableTiers: ["vm" as const],
      usage: { instances: 1, sessions: 2 },
    }

    it("shows each provider's live state, and a provider saved since startup as not running", () => {
      hookState = {
        status: "ready",
        view: withProviders([e2b("e2b"), e2b("k8s"), e2b("new")]),
        running: {
          kind: "providers",
          providers: [
            live,
            {
              ...live,
              id: "k8s",
              reachable: false,
              unavailableCode: "sandbox_provider_unreachable",
            },
          ],
        },
        busy: false,
      }
      render(<RemoteSandboxesSection />)
      expect(screen.getByTestId("remote-sandbox-live-e2b")).toHaveTextContent(
        "Running: reachable, 1 sandbox and 2 sessions in use"
      )
      expect(screen.getByTestId("remote-sandbox-live-k8s")).toHaveTextContent(
        "Running: unreachable (sandbox_provider_unreachable)"
      )
      expect(screen.getByTestId("remote-sandbox-live-new")).toHaveTextContent(
        en.providers.live.notRunning
      )
    })

    it("says every provider is not running when no pool is", () => {
      hookState = {
        status: "ready",
        view: withProviders([e2b("e2b")]),
        running: { kind: "off" },
        busy: false,
      }
      render(<RemoteSandboxesSection />)
      expect(screen.getByTestId("remote-sandbox-live-e2b")).toHaveTextContent(
        en.providers.live.notRunning
      )
    })

    it("says the running pool could not be read, without guessing per provider", () => {
      hookState = {
        status: "ready",
        view: withProviders([e2b("e2b")]),
        running: { kind: "unreadable", problem: { code: "x", message: "timeout" } },
        busy: false,
      }
      render(<RemoteSandboxesSection />)
      expect(screen.queryByTestId("remote-sandbox-live-e2b")).not.toBeInTheDocument()
      expect(screen.getByTestId("remote-sandboxes-running-unreadable")).toHaveTextContent("timeout")
    })
  })
})
