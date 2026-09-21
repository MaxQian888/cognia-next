/** @jest-environment jsdom */

const client = {
  fetchEnvironmentCatalog: jest.fn(),
  environmentDeclarationRead: jest.fn(),
  environmentDriverStatus: jest.fn(),
  fetchEnvironmentApprovals: jest.fn(),
  environmentApprovalApprove: jest.fn(),
  environmentApprovalRevoke: jest.fn(),
  environmentEgressGrantCreate: jest.fn(),
  environmentImageInspect: jest.fn(),
  environmentBuildStart: jest.fn(),
  environmentBuildGet: jest.fn(),
  environmentBuildCancel: jest.fn(),
  environmentPortsList: jest.fn(),
}

jest.mock("@/lib/project-environment/environment-client", () => {
  const actual = jest.requireActual("@/lib/project-environment/environment-client")
  return {
    ...actual,
    environmentPortsList: (...args: unknown[]) => client.environmentPortsList(...args),
    environmentBuildStart: (...args: unknown[]) => client.environmentBuildStart(...args),
    environmentBuildGet: (...args: unknown[]) => client.environmentBuildGet(...args),
    environmentBuildCancel: (...args: unknown[]) => client.environmentBuildCancel(...args),
    fetchEnvironmentCatalog: (...args: unknown[]) => client.fetchEnvironmentCatalog(...args),
    environmentDeclarationRead: (...args: unknown[]) => client.environmentDeclarationRead(...args),
    environmentDriverStatus: (...args: unknown[]) => client.environmentDriverStatus(...args),
    fetchEnvironmentApprovals: (...args: unknown[]) => client.fetchEnvironmentApprovals(...args),
    environmentApprovalApprove: (...args: unknown[]) => client.environmentApprovalApprove(...args),
    environmentApprovalRevoke: (...args: unknown[]) => client.environmentApprovalRevoke(...args),
    environmentEgressGrantCreate: (...args: unknown[]) =>
      client.environmentEgressGrantCreate(...args),
    environmentImageInspect: (...args: unknown[]) => client.environmentImageInspect(...args),
  }
})

jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/tauri/opener", () => ({ openExternal: jest.fn() }))
jest.mock("@/lib/tauri/transport-routing", () => ({
  ...jest.requireActual("@/lib/tauri/transport-routing"),
  getActiveRemoteEndpoint: jest.fn(() => null),
}))
jest.mock("@/lib/codeserver/remote-relay", () => ({
  ensureRemotePortRelay: jest.fn(),
  ensureLocalPortRelay: jest.fn(),
  stopRemotePortRelay: jest.fn(async () => undefined),
}))
import { isTauri } from "@/lib/tauri"
import { openExternal } from "@/lib/tauri/opener"
import { ensureLocalPortRelay, stopRemotePortRelay } from "@/lib/codeserver/remote-relay"

import { act, renderHook, waitFor } from "@testing-library/react"

import {
  defaultRuntimeSelection,
  useProjectRuntimeEnvironment,
  type UseProjectRuntimeEnvironmentInput,
} from "./use-project-runtime-environment"
import type { RunEnvironmentSources } from "@/lib/sandbox/run-environment"
import type { EnvironmentCatalogView } from "@/types/sandbox/environment-catalog"
import { environmentDeclarationDigest } from "@/lib/project-environment/environment-declaration"
import { declarationRuntimeFieldsDigest } from "@/lib/project-environment/environment-spec-digest"
import { parseDevcontainer } from "@/lib/project-environment/devcontainer"

const DIGEST = `sha256:${"a".repeat(64)}`
const DEVCONTAINER = JSON.stringify({ image: "python:3.12-slim" })

function catalog(over: Partial<EnvironmentCatalogView> = {}): EnvironmentCatalogView {
  return {
    poolEnabled: true,
    multiTenant: false,
    floor: "container",
    defaultEntryId: "default",
    entries: [
      {
        id: "default",
        scope: "baseline",
        label: "Default",
        image: { registry: "ghcr.io", repository: "cognia/runner", digest: DIGEST },
        effectiveFloor: "container",
        sizeClassIds: ["small"],
        source: "manual",
      },
    ],
    rejected: [],
    sizeClasses: [
      {
        id: "small",
        label: "Small",
        cpuMillis: 1000,
        memoryMib: 2048,
        ephemeralStorageMib: 8192,
        volumeMib: 20480,
      },
    ],
    egressPresets: [],
    bundle: { current: { digest: DIGEST, releaseTag: "v1" }, retained: [] },
    ...over,
  }
}

const sources: RunEnvironmentSources = {
  selection: async () => ({ runtime: undefined, policy: undefined }),
  catalog: async () => catalog(),
  declarationFiles: async () => ({ files: [], searched: [] }),
  workspaceConfig: async () => ({ kind: "absent" }),
  restricted: async () => false,
  serverApprovals: async () => [],
  deviceApproval: async () => undefined,
}

function input(
  over: Partial<UseProjectRuntimeEnvironmentInput> = {}
): UseProjectRuntimeEnvironmentInput {
  return {
    projectId: "prj1",
    executionRoot: "/repo",
    project: { roots: [{ id: "r1", path: "/repo", isPrimary: true }] },
    saved: undefined,
    policy: undefined,
    repository: { remote: "git@github.com:acme/app.git", commitSha: "c".repeat(40) },
    onSave: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  ;(isTauri as jest.Mock).mockReturnValue(false)
  ;(ensureLocalPortRelay as jest.Mock).mockReset()
  ;(stopRemotePortRelay as jest.Mock).mockClear()
  ;(openExternal as jest.Mock).mockClear()
  for (const mock of Object.values(client)) mock.mockReset()
  client.fetchEnvironmentCatalog.mockResolvedValue(catalog())
  client.environmentPortsList.mockResolvedValue([])
  client.environmentDeclarationRead.mockResolvedValue({ files: [], searched: [] })
  client.environmentDriverStatus.mockResolvedValue({
    driver: "docker",
    deploymentId: "dep",
    instanceId: "inst",
    multiTenant: false,
    isolationFloor: "container",
    availableTiers: ["container"],
    reachable: true,
    bundles: [],
  })
  client.fetchEnvironmentApprovals.mockResolvedValue([])
})

describe("useProjectRuntimeEnvironment", () => {
  it.each([new Error("save failed"), { message: "save failed" }, "save failed"])(
    "preserves the draft and releases busy state when saving fails (%p)",
    async (cause) => {
      const onSave = jest.fn().mockRejectedValue(cause)
      const { result } = renderHook(() => useProjectRuntimeEnvironment(input({ onSave }), sources))
      await waitFor(() => expect(result.current.loading).toBe(false))
      const selection = defaultRuntimeSelection()
      act(() => result.current.setDraft(selection))
      await act(() => result.current.save())
      expect(result.current.error).toBe("save failed")
      expect(result.current.busy).toBe(false)
      expect(result.current.draft).toEqual(selection)
    }
  )

  it("can inspect a project without a checkout or optional host status", async () => {
    client.environmentDriverStatus.mockRejectedValue(new Error("driver offline"))
    client.fetchEnvironmentApprovals.mockRejectedValue(new Error("ledger offline"))
    const { result } = renderHook(() =>
      useProjectRuntimeEnvironment(
        input({ executionRoot: undefined, repository: undefined }),
        sources
      )
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(client.environmentDeclarationRead).not.toHaveBeenCalled()
    expect(result.current.driver).toBeUndefined()
    expect(result.current.approvals).toEqual([])
    expect(result.current.declaration).toEqual({ kind: "absent" })
  })

  it("loads the catalog, the driver and the approvals for an enabled pool", async () => {
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.poolEnabled).toBe(true)
    expect(result.current.driver?.driver).toBe("docker")
    expect(client.fetchEnvironmentApprovals).toHaveBeenCalledWith("prj1")
  })

  // Q39. A deployment that never opted in is not an error, and the panel must
  // not ask the driver or the ledger about a pool that does not exist.
  it("reports a pool-off deployment as off, not as a failure", async () => {
    client.fetchEnvironmentCatalog.mockRejectedValue({
      code: "sandbox_pool_disabled",
      message: "off",
    })
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.poolEnabled).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(client.environmentDriverStatus).not.toHaveBeenCalled()
    expect(client.fetchEnvironmentApprovals).not.toHaveBeenCalled()
  })

  it("surfaces a catalog read that failed for another reason", async () => {
    client.fetchEnvironmentCatalog.mockRejectedValue(new Error("host down"))
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe("host down")
  })

  // The preview runs the real resolver with the UNSAVED selection, so what the
  // panel shows is what a run would do — not a re-implementation of it.
  it("previews the draft through the real resolver", async () => {
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preview).toEqual({ kind: "off" })

    act(() => result.current.setDraft(defaultRuntimeSelection()))

    await waitFor(() => expect(result.current.preview?.kind).toBe("placed"))
    const preview = result.current.preview
    if (preview?.kind !== "placed") throw new Error("unreachable")
    expect(preview.placement.spec.source).toEqual({
      kind: "deployment-default",
      catalogEntryId: "default",
    })
  })

  it("previews a refusal for an entry that is not in the catalog", async () => {
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() =>
      result.current.setDraft({
        source: { kind: "catalog", catalogEntryId: "gone" },
        updatedAt: 1,
      })
    )

    await waitFor(() =>
      expect(result.current.preview).toMatchObject({
        kind: "refused",
        code: "catalog_entry_unavailable",
      })
    )
  })

  it("saves the draft through the caller", async () => {
    const onSave = jest.fn()
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input({ onSave }), sources))
    await waitFor(() => expect(result.current.loading).toBe(false))
    const selection = defaultRuntimeSelection()

    act(() => result.current.setDraft(selection))
    await act(() => result.current.save())

    expect(onSave).toHaveBeenCalledWith(selection)
  })

  // Typing must not be discarded by a re-render that carries the same saved
  // value; only a new save or another project re-seeds the form.
  it("keeps the draft across a re-render with the same saved selection", async () => {
    const saved = { source: { kind: "auto" as const }, updatedAt: 5 }
    const { result, rerender } = renderHook(
      (props: UseProjectRuntimeEnvironmentInput) => useProjectRuntimeEnvironment(props, sources),
      { initialProps: input({ saved }) }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setDraft({ ...saved, lifecycle: "ephemeral" }))
    rerender(input({ saved }))
    expect(result.current.draft?.lifecycle).toBe("ephemeral")

    rerender(input({ saved: { ...saved, updatedAt: 6 } }))
    await waitFor(() => expect(result.current.draft?.lifecycle).toBeUndefined())
  })

  describe("approving a declaration", () => {
    async function declared() {
      const parsed = parseDevcontainer(DEVCONTAINER, ".devcontainer.json")
      if (!parsed.ok) throw new Error("fixture does not parse")
      return parsed.declaration
    }

    beforeEach(() => {
      client.environmentDeclarationRead.mockResolvedValue({
        files: [
          {
            path: "/repo/.devcontainer.json",
            relativePath: ".devcontainer.json",
            file: "devcontainer",
            contents: DEVCONTAINER,
            bytesSha256: "b".repeat(64),
          },
        ],
        searched: [".devcontainer.json"],
      })
      client.environmentImageInspect.mockResolvedValue({
        registry: "docker.io",
        repository: "library/python",
        digest: DIGEST,
        mediaType: "application/vnd.oci.image.index.v1+json",
        platforms: [],
      })
      client.environmentApprovalApprove.mockResolvedValue({})
    })

    // What the person approves is what runs: the tag is resolved to the
    // digest it names now, and the runtime fields are digested the way the
    // resolver will digest them once the declaration is the source.
    it("pins the tag to a digest and records the digests admission compares", async () => {
      const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))
      await waitFor(() => expect(result.current.declaration.kind).toBe("declared"))

      await act(() => result.current.approve())

      const declaration = await declared()
      expect(client.environmentImageInspect).toHaveBeenCalledWith(
        "docker.io/library/python:3.12-slim"
      )
      expect(client.environmentApprovalApprove).toHaveBeenCalledWith({
        id: expect.stringMatching(/^env-approval:/),
        projectId: "prj1",
        normalizedRemote: "git@github.com:acme/app.git",
        path: ".devcontainer.json",
        declarationDigest: await environmentDeclarationDigest(declaration),
        resolvedImage: { registry: "docker.io", repository: "library/python", digest: DIGEST },
        runtimeFieldsDigest: await declarationRuntimeFieldsDigest(declaration),
      })
      expect(result.current.error).toBeUndefined()
    })

    // A registry that refuses must leave nothing approved and say why.
    it("approves nothing when the image cannot be resolved", async () => {
      client.environmentImageInspect.mockRejectedValue({
        code: "catalog_registry_not_allowlisted",
        message: "docker.io/library/python is not on this deployment's registry allowlist",
      })
      const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))
      await waitFor(() => expect(result.current.declaration.kind).toBe("declared"))

      await act(() => result.current.approve())

      expect(client.environmentApprovalApprove).not.toHaveBeenCalled()
      expect(result.current.error).toMatch(/allowlist/)
      expect(result.current.busy).toBe(false)
    })
  })

  it("revokes an approval and reloads the ledger", async () => {
    client.environmentApprovalRevoke.mockResolvedValue({})
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))
    await waitFor(() => expect(result.current.loading).toBe(false))
    client.fetchEnvironmentApprovals.mockClear()

    await act(() => result.current.revoke("apr1"))

    expect(client.environmentApprovalRevoke).toHaveBeenCalledWith("apr1")
    expect(client.fetchEnvironmentApprovals).toHaveBeenCalled()
  })

  it("requests an egress grant for this project", async () => {
    client.environmentEgressGrantCreate.mockResolvedValue({})
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(() => result.current.grantEgress("allowlist", ["pypi.org"]))

    expect(client.environmentEgressGrantCreate).toHaveBeenCalledWith({
      id: expect.stringMatching(/^egress-grant:/),
      projectId: "prj1",
      tier: "allowlist",
      domains: ["pypi.org"],
    })
  })
})

describe("build-backed declarations", () => {
  async function renderBuild() {
    const contents = JSON.stringify({ build: { dockerfile: "Dockerfile" } })
    client.environmentDeclarationRead.mockResolvedValue({
      files: [
        {
          relativePath: ".devcontainer.json",
          path: "/repo/.devcontainer.json",
          file: "devcontainer",
          contents,
          bytesSha256: "b".repeat(64),
        },
      ],
      searched: [],
    })
    const hook = renderHook(() => useProjectRuntimeEnvironment(input(), sources))
    await waitFor(() => expect(hook.result.current.declaration.kind).toBe("declared"))
    const declaration = hook.result.current.declaration
    if (declaration.kind !== "declared") throw new Error("missing declaration")
    const record = {
      buildKey: "a".repeat(64),
      imageId: DIGEST,
      projectId: "prj1",
      commitSha: "c".repeat(40),
      declarationPath: ".devcontainer.json",
      declarationDigest: declaration.digest,
      declarationBytesSha256: "b".repeat(64),
      runtimeConfiguration: {
        containerEnv: { FEATURE: "yes" },
        postCreateCommands: ["feature-init"],
      },
      sourceHash: "s",
      cliVersion: "0.80.0",
      platform: "linux/arm64",
      createdAt: 1,
    }
    return { ...hook, record }
  }

  it("requires a successful build and approves its immutable identity without a registry lookup", async () => {
    const { result, record } = await renderBuild()
    await act(() => result.current.approve())
    expect(client.environmentApprovalApprove).not.toHaveBeenCalled()
    client.environmentBuildStart.mockResolvedValue({
      jobId: "job",
      projectId: "prj1",
      status: "succeeded",
      record,
    })
    await act(() => result.current.buildEnvironment())
    expect(client.environmentBuildStart).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "prj1",
        cwd: "/repo",
        declarationBytesSha256: "b".repeat(64),
        declarationDigest: record.declarationDigest,
        commitSha: "c".repeat(40),
      })
    )
    await act(() => result.current.approve())
    expect(client.environmentApprovalApprove).toHaveBeenCalledWith(
      expect.objectContaining({ buildKey: record.buildKey })
    )
    expect(client.environmentApprovalApprove.mock.calls[0][0]).not.toHaveProperty("resolvedImage")
    expect(client.environmentApprovalApprove.mock.calls[0][0].runtimeFieldsDigest).toBe(
      await declarationRuntimeFieldsDigest({
        containerEnv: { FEATURE: "yes" },
        lifecycleCommands: {
          postCreate: { kind: "sequence", commands: [{ kind: "shell", command: "feature-init" }] },
        },
        forwardPorts: [],
      })
    )
    expect(client.environmentImageInspect).not.toHaveBeenCalled()
  })

  it("refuses a successful response belonging to another commit", async () => {
    const { result, record } = await renderBuild()
    client.environmentBuildStart.mockResolvedValue({
      jobId: "job",
      projectId: "prj1",
      status: "succeeded",
      record: { ...record, commitSha: "d".repeat(40) },
    })
    await act(() => result.current.buildEnvironment())
    await act(() => result.current.approve())
    expect(client.environmentApprovalApprove).not.toHaveBeenCalled()
  })

  it("cancels a job returned after the panel unmounts", async () => {
    const { result, unmount } = await renderBuild()
    let resolve!: (value: unknown) => void
    client.environmentBuildStart.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done
        })
    )
    let pending!: Promise<void>
    act(() => {
      pending = result.current.buildEnvironment()
    })
    unmount()
    await act(async () => {
      resolve({ projectId: "prj1", jobId: "late", status: "building" })
      await pending
    })
    expect(client.environmentBuildCancel).toHaveBeenCalledWith("prj1", "late")
  })
})

it("opens an admitted local port through the native relay and disposes it on close", async () => {
  ;(isTauri as jest.Mock).mockReturnValue(true)
  const port = {
    projectId: "prj1",
    containerId: "container",
    port: 3000,
    path: "/api/environment/ports/prj1/container/3000/",
  }
  client.environmentPortsList.mockResolvedValue([port])
  ;(ensureLocalPortRelay as jest.Mock).mockResolvedValue({
    port: 50000,
    url: "http://127.0.0.1:50000/",
  })
  const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))
  await waitFor(() => expect(result.current.ports).toEqual([port]))
  await act(() => result.current.openPort(port))
  expect(ensureLocalPortRelay).toHaveBeenCalledWith(
    { projectId: "prj1", containerId: "container", port: 3000 },
    expect.stringMatching(/^environment-port:/)
  )
  expect(openExternal).toHaveBeenCalledWith("http://127.0.0.1:50000/")
  await act(() => result.current.closePort(port.path))
  expect(stopRemotePortRelay).toHaveBeenCalledWith(expect.stringMatching(/^environment-port:/))
  expect(result.current.openedPorts).toEqual({})
})
