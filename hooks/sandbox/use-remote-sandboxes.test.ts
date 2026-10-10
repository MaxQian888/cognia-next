/** @jest-environment jsdom */

const client = {
  remoteSandboxesGet: jest.fn(),
  remoteSandboxesSet: jest.fn(),
  environmentDriverStatus: jest.fn(),
}

jest.mock("@/lib/project-environment/environment-client", () => {
  const actual = jest.requireActual("@/lib/project-environment/environment-client")
  return {
    ...actual,
    environmentDriverStatus: (...args: unknown[]) => client.environmentDriverStatus(...args),
  }
})

jest.mock("@/lib/sandbox/remote-sandboxes-client", () => {
  const actual = jest.requireActual("@/lib/sandbox/remote-sandboxes-client")
  return {
    ...actual,
    remoteSandboxesGet: (...args: unknown[]) => client.remoteSandboxesGet(...args),
    remoteSandboxesSet: (...args: unknown[]) => client.remoteSandboxesSet(...args),
  }
})

import { act, renderHook, waitFor } from "@testing-library/react"

import { useRemoteSandboxes } from "./use-remote-sandboxes"
import { emptyProviderDraft, type ProviderDraft } from "@/lib/sandbox/remote-sandbox-draft"
import type {
  RemoteSandboxesUpdate,
  RemoteSandboxesView,
  SandboxProviderConfig,
} from "@/types/sandbox/remote-sandboxes"

const e2bProvider = (id: string, secretId = `remote-sandbox:${id}`): SandboxProviderConfig => ({
  id,
  kind: "e2b",
  credential: { secretId },
  limits: { maxConcurrent: 4, maxLifetimeSecs: 7200, idleTimeoutSecs: 600 },
  settings: {
    apiUrl: "https://api.e2b.app",
    domain: "e2b.app",
    templatePrefix: "cognia",
    templateBuildTimeoutSecs: 1800,
  },
})

function view(overrides: Partial<RemoteSandboxesView> = {}): RemoteSandboxesView {
  return {
    settings: { version: 1, providers: { version: 1, providers: [] }, registryAllowlist: [] },
    availability: "no_providers",
    bundle: null,
    storedSecretIds: [],
    restartRequired: false,
    installError: null,
    ...overrides,
  }
}

/** The Host's answer to a set: the document it was sent, with the secrets it stored. */
function echo(stored: string[] = []) {
  client.remoteSandboxesSet.mockImplementation(async (update: RemoteSandboxesUpdate) =>
    view({
      settings: update.settings,
      storedSecretIds: stored,
      restartRequired: true,
      availability: update.settings.providers.providers.length > 0 ? "active" : "no_providers",
    })
  )
}

const lastUpdate = (): RemoteSandboxesUpdate =>
  client.remoteSandboxesSet.mock.calls.at(-1)?.[0] as RemoteSandboxesUpdate

function e2bDraft(overrides: Partial<ProviderDraft> = {}): ProviderDraft {
  return { ...emptyProviderDraft("e2b"), id: "e2b", credential: "key", ...overrides }
}

async function ready(initial: RemoteSandboxesView) {
  client.remoteSandboxesGet.mockResolvedValue(initial)
  const hook = renderHook(() => useRemoteSandboxes())
  await waitFor(() => expect(hook.result.current.status).toBe("ready"))
  return hook
}

const POOL_OFF = { code: "sandbox_pool_disabled", message: "off", retryable: false }

beforeEach(() => {
  client.remoteSandboxesGet.mockReset()
  client.remoteSandboxesSet.mockReset()
  client.environmentDriverStatus.mockReset().mockRejectedValue(POOL_OFF)
})

describe("useRemoteSandboxes", () => {
  it("reads the view once on mount", async () => {
    const { result } = await ready(view())
    expect(result.current.view?.availability).toBe("no_providers")
    expect(client.remoteSandboxesGet).toHaveBeenCalledTimes(1)
  })

  it("says no pool is running when the driver answers that it is off", async () => {
    const { result } = await ready(view())
    expect(result.current.running).toEqual({ kind: "off" })
  })

  it("lists the running pool's remote providers with their state", async () => {
    const e2b = {
      id: "e2b",
      driver: "e2b",
      remote: true,
      isDefault: true,
      reachable: true,
      availableTiers: ["vm"],
      usage: { instances: 1, sessions: 2 },
    }
    client.environmentDriverStatus.mockResolvedValue({
      driver: "provider-set",
      deploymentId: "d",
      instanceId: "i",
      multiTenant: false,
      isolationFloor: "container",
      availableTiers: ["vm"],
      reachable: true,
      bundles: [],
      providers: [{ ...e2b, id: "local", remote: false }, e2b],
    })
    const { result } = await ready(view())
    expect(result.current.running).toEqual({ kind: "providers", providers: [e2b] })
  })

  it("says the running pool could not be read, apart from the settings", async () => {
    client.environmentDriverStatus.mockRejectedValue({
      code: "sandbox_driver_unreachable",
      message: "timeout",
      retryable: true,
    })
    const { result } = await ready(view())
    expect(result.current.running).toEqual({
      kind: "unreadable",
      problem: { code: "sandbox_driver_unreachable", message: "timeout" },
    })
  })

  it("keeps the running pool's status across a save", async () => {
    const { result } = await ready(view())
    echo(["remote-sandbox:e2b"])
    await act(async () => {
      await result.current.saveProvider(e2bDraft())
    })
    expect(result.current.running).toEqual({ kind: "off" })
    expect(client.environmentDriverStatus).toHaveBeenCalledTimes(1)
  })

  it("reports a failed first read as failed, with the Host's code", async () => {
    client.remoteSandboxesGet.mockRejectedValue({
      code: "remote_sandboxes_unreadable",
      message: "bad json",
      retryable: false,
    })
    const { result } = renderHook(() => useRemoteSandboxes())
    await waitFor(() => expect(result.current.status).toBe("failed"))
    expect(result.current.loadProblem).toEqual({
      code: "remote_sandboxes_unreadable",
      message: "bad json",
    })
  })

  it("keeps the page on a failed reload", async () => {
    const { result } = await ready(view())
    client.remoteSandboxesGet.mockRejectedValue(new Error("gone"))
    await act(() => result.current.reload())
    expect(result.current.status).toBe("ready")
    expect(result.current.view).toBeDefined()
    expect(result.current.loadProblem?.message).toBe("gone")
    expect(result.current.busy).toBe(false)
  })

  it("adds a provider with its secret and takes the Host's view", async () => {
    const { result } = await ready(view())
    echo(["remote-sandbox:e2b"])
    let outcome
    await act(async () => {
      outcome = await result.current.saveProvider(e2bDraft())
    })
    expect(outcome).toEqual({ ok: true })
    expect(lastUpdate().settings.providers.providers.map((p) => p.id)).toEqual(["e2b"])
    expect(lastUpdate().secrets).toEqual({ "remote-sandbox:e2b": "key" })
    expect(result.current.view?.restartRequired).toBe(true)
    expect(result.current.view?.storedSecretIds).toEqual(["remote-sandbox:e2b"])
  })

  it("sends no secrets field when an edit types no credential", async () => {
    const { result } = await ready(
      view({
        settings: {
          version: 1,
          providers: { version: 1, providers: [e2bProvider("e2b")] },
          registryAllowlist: [],
        },
        storedSecretIds: ["remote-sandbox:e2b"],
      })
    )
    echo(["remote-sandbox:e2b"])
    await act(async () => {
      await result.current.saveProvider(
        e2bDraft({
          credential: "",
          label: "Cloud",
          existingCredential: { secretId: "remote-sandbox:e2b" },
        }),
        "e2b"
      )
    })
    expect(lastUpdate()).not.toHaveProperty("secrets")
    expect(lastUpdate().settings.providers.providers[0]?.label).toBe("Cloud")
  })

  it("moves the default pointer with a renamed provider", async () => {
    const { result } = await ready(
      view({
        settings: {
          version: 1,
          providers: {
            version: 1,
            providers: [e2bProvider("old"), e2bProvider("other")],
            defaultProviderId: "old",
          },
          registryAllowlist: [],
        },
        storedSecretIds: ["remote-sandbox:old", "remote-sandbox:other"],
      })
    )
    echo()
    await act(async () => {
      await result.current.saveProvider(
        e2bDraft({
          id: "new",
          credential: "",
          existingCredential: { secretId: "remote-sandbox:old" },
        }),
        "old"
      )
    })
    expect(lastUpdate().settings.providers.defaultProviderId).toBe("new")
    expect(lastUpdate().settings.providers.providers.map((p) => p.id)).toEqual(["new", "other"])
  })

  it("never deletes a secret another provider still reads", async () => {
    const shared = "remote-sandbox:shared"
    const { result } = await ready(
      view({
        settings: {
          version: 1,
          providers: {
            version: 1,
            providers: [e2bProvider("a", shared), e2bProvider("b", shared)],
          },
          registryAllowlist: [],
        },
        storedSecretIds: [shared],
      })
    )
    echo()
    await act(async () => {
      await result.current.saveProvider(
        e2bDraft({ id: "a", credential: "fresh", existingCredential: { secretId: shared } }),
        "a"
      )
    })
    expect(lastUpdate().secrets).toEqual({ "remote-sandbox:a": "fresh" })
  })

  it("removes a provider, its default pointer and its secret", async () => {
    const { result } = await ready(
      view({
        settings: {
          version: 1,
          providers: { version: 1, providers: [e2bProvider("e2b")], defaultProviderId: "e2b" },
          registryAllowlist: [],
        },
        storedSecretIds: ["remote-sandbox:e2b"],
      })
    )
    echo()
    await act(async () => {
      await result.current.removeProvider("e2b")
    })
    expect(lastUpdate()).toEqual({
      settings: { version: 1, providers: { version: 1, providers: [] }, registryAllowlist: [] },
      secrets: { "remote-sandbox:e2b": null },
    })
  })

  it("sets and clears the default provider", async () => {
    const { result } = await ready(
      view({
        settings: {
          version: 1,
          providers: { version: 1, providers: [e2bProvider("a"), e2bProvider("b")] },
          registryAllowlist: [],
        },
      })
    )
    echo()
    await act(async () => {
      await result.current.setDefaultProvider("b")
    })
    expect(lastUpdate().settings.providers.defaultProviderId).toBe("b")
    await act(async () => {
      await result.current.setDefaultProvider(undefined)
    })
    expect(lastUpdate().settings.providers).not.toHaveProperty("defaultProviderId")
  })

  it("saves a normalized allowlist and refuses an invalid one locally", async () => {
    const { result } = await ready(view())
    echo()
    let outcome
    await act(async () => {
      outcome = await result.current.saveRegistryAllowlist([
        { registry: "nohost", repositoryPrefix: "" },
      ])
    })
    expect(outcome).toEqual({
      ok: false,
      problem: { code: "remote_sandboxes_registry_invalid", message: "1: registry_invalid" },
    })
    expect(client.remoteSandboxesSet).not.toHaveBeenCalled()

    await act(async () => {
      outcome = await result.current.saveRegistryAllowlist([
        { registry: "GHCR.io", repositoryPrefix: " acme " },
      ])
    })
    expect(outcome).toEqual({ ok: true })
    expect(lastUpdate().settings.registryAllowlist).toEqual([
      { registry: "ghcr.io", repositoryPrefix: "acme" },
    ])
  })

  it("returns the Host's refusal and stays ready", async () => {
    const { result } = await ready(view())
    client.remoteSandboxesSet.mockRejectedValue({
      code: "remote_sandboxes_invalid",
      message: "e2b: domain is not a DNS name",
      retryable: false,
    })
    let outcome
    await act(async () => {
      outcome = await result.current.saveProvider(e2bDraft())
    })
    expect(outcome).toEqual({
      ok: false,
      problem: { code: "remote_sandboxes_invalid", message: "e2b: domain is not a DNS name" },
    })
    expect(result.current.status).toBe("ready")
    expect(result.current.busy).toBe(false)
  })

  it("refuses a form with problems without calling the Host", async () => {
    const { result } = await ready(view())
    let outcome
    await act(async () => {
      outcome = await result.current.saveProvider(e2bDraft({ id: "Bad" }))
    })
    expect(outcome).toEqual({
      ok: false,
      problem: { code: "remote_sandboxes_invalid", message: "id" },
    })
    expect(client.remoteSandboxesSet).not.toHaveBeenCalled()
  })
})
