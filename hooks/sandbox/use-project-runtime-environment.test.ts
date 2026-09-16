/** @jest-environment jsdom */

const client = {
  fetchEnvironmentCatalog: jest.fn(),
  environmentDeclarationRead: jest.fn(),
  environmentDriverStatus: jest.fn(),
  environmentApprovalList: jest.fn(),
  environmentApprovalApprove: jest.fn(),
  environmentApprovalRevoke: jest.fn(),
  environmentEgressGrantCreate: jest.fn(),
  environmentImageInspect: jest.fn(),
}

jest.mock("@/lib/project-environment/environment-client", () => {
  const actual = jest.requireActual("@/lib/project-environment/environment-client")
  return {
    ...actual,
    fetchEnvironmentCatalog: (...args: unknown[]) => client.fetchEnvironmentCatalog(...args),
    environmentDeclarationRead: (...args: unknown[]) => client.environmentDeclarationRead(...args),
    environmentDriverStatus: (...args: unknown[]) => client.environmentDriverStatus(...args),
    environmentApprovalList: (...args: unknown[]) => client.environmentApprovalList(...args),
    environmentApprovalApprove: (...args: unknown[]) => client.environmentApprovalApprove(...args),
    environmentApprovalRevoke: (...args: unknown[]) => client.environmentApprovalRevoke(...args),
    environmentEgressGrantCreate: (...args: unknown[]) =>
      client.environmentEgressGrantCreate(...args),
    environmentImageInspect: (...args: unknown[]) => client.environmentImageInspect(...args),
  }
})

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
  for (const mock of Object.values(client)) mock.mockReset()
  client.fetchEnvironmentCatalog.mockResolvedValue(catalog())
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
  client.environmentApprovalList.mockResolvedValue({ items: [] })
})

describe("useProjectRuntimeEnvironment", () => {
  it("loads the catalog, the driver and the approvals for an enabled pool", async () => {
    const { result } = renderHook(() => useProjectRuntimeEnvironment(input(), sources))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.poolEnabled).toBe(true)
    expect(result.current.driver?.driver).toBe("docker")
    expect(client.environmentApprovalList).toHaveBeenCalledWith({
      projectId: "prj1",
      pageSize: 200,
    })
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
    expect(client.environmentApprovalList).not.toHaveBeenCalled()
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
    client.environmentApprovalList.mockClear()

    await act(() => result.current.revoke("apr1"))

    expect(client.environmentApprovalRevoke).toHaveBeenCalledWith("apr1")
    expect(client.environmentApprovalList).toHaveBeenCalled()
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
