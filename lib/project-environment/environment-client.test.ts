/** @jest-environment jsdom */
import { transport } from "@/lib/tauri/transport-instance"
import {
  declarationReader,
  environmentApprovalApprove,
  environmentApprovalList,
  environmentCatalogCreate,
  environmentCatalogDelete,
  environmentCatalogGet,
  environmentCatalogList,
  environmentCatalogUpdate,
  environmentDeclarationRead,
  environmentDriverStatus,
  environmentImageInspect,
  commonImageUser,
  fetchEnvironmentCatalog,
  fetchEnvironmentCatalogRows,
  environmentEgressGrantCreate,
  environmentEgressGrantDelete,
  environmentProbeGet,
  environmentApprovalGet,
  environmentApprovalRevoke,
  environmentSpecResolvePreview,
  isPoolDisabled,
  POOL_DISABLED_CODE,
  type CatalogEntryRecord,
  type DeclarationReadResult,
} from "./environment-client"

const call = jest.spyOn(transport, "call")

beforeEach(() => {
  call.mockReset()
  call.mockResolvedValue(undefined as never)
})

function entry(): CatalogEntryRecord {
  return {
    id: "e1",
    scope: "tenant",
    label: "Node 22",
    image: { registry: "ghcr.io", repository: "acme/dev", digest: `sha256:${"a".repeat(64)}` },
    isolationFloor: "container",
    sizeClassIds: ["small"],
    source: "manual",
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("the wire names and arguments", () => {
  // The command names are the contract with `rpc/environment.rs`. A typo here
  // is an `unknown_command` at runtime and nothing catches it earlier, so the
  // whole surface is pinned in one table.
  it("sends each command with the arguments its dispatch arm reads", async () => {
    await environmentCatalogList({ pageSize: 10, pageToken: "t" })
    await environmentCatalogGet("e1")
    await environmentCatalogCreate(entry())
    await environmentCatalogUpdate(entry())
    await environmentCatalogDelete("e1")
    await environmentDeclarationRead("/repo")
    await environmentSpecResolvePreview({ projectId: "prj1" })
    await environmentApprovalList({ projectId: "prj1", includeRevoked: true })
    await environmentApprovalGet("a1")
    await environmentApprovalRevoke("a1")
    await environmentEgressGrantDelete("g1")
    await environmentProbeGet("sha256:image", "sha256:bundle")
    await environmentDriverStatus()
    await environmentImageInspect("python:3.12-slim")

    expect(call.mock.calls).toEqual([
      ["environment_catalog_list", { pageSize: 10, pageToken: "t" }],
      ["environment_catalog_get", { id: "e1" }],
      ["environment_catalog_create", { entry: entry() }],
      ["environment_catalog_update", { entry: entry() }],
      ["environment_catalog_delete", { id: "e1" }],
      ["environment_declaration_read", { workspaceRoot: "/repo" }],
      ["environment_spec_resolve_preview", { spec: { projectId: "prj1" } }],
      ["environment_approval_list", { projectId: "prj1", includeRevoked: true }],
      ["environment_approval_get", { id: "a1" }],
      ["environment_approval_revoke", { id: "a1" }],
      ["environment_egress_grant_delete", { id: "g1" }],
      ["environment_probe_get", { userImageDigest: "sha256:image", bundleDigest: "sha256:bundle" }],
      ["environment_driver_status", {}],
      ["environment_image_inspect", { reference: "python:3.12-slim" }],
    ])
  })

  // The approver, the moment and the authority are the Host's to state
  // (`ApprovalRequest` in `crates/cognia-environment/src/approval.rs`). The
  // client sends the request verbatim and adds nothing.
  it("sends an approval request without inventing an approver", async () => {
    await environmentApprovalApprove({
      id: "a1",
      projectId: "prj1",
      normalizedRemote: "https://github.com/acme/app.git",
      path: ".devcontainer.json",
      declarationDigest: "d".repeat(64),
      runtimeFieldsDigest: "r".repeat(64),
    })

    expect(call.mock.calls[0]?.[1]).toEqual({
      approval: {
        id: "a1",
        projectId: "prj1",
        normalizedRemote: "https://github.com/acme/app.git",
        path: ".devcontainer.json",
        declarationDigest: "d".repeat(64),
        runtimeFieldsDigest: "r".repeat(64),
      },
    })
  })

  it("nests an egress grant under the key its arm reads", async () => {
    await environmentEgressGrantCreate({
      id: "g1",
      projectId: "prj1",
      tier: "allowlist",
      domains: ["registry.npmjs.org"],
    })

    expect(call.mock.calls[0]).toEqual([
      "environment_egress_grant_create",
      {
        grant: { id: "g1", projectId: "prj1", tier: "allowlist", domains: ["registry.npmjs.org"] },
      },
    ])
  })
})

describe("isPoolDisabled", () => {
  // Q39: with the pool off every command refuses, and that refusal is the
  // ordinary state of a deployment that never opted in — not a failure to
  // report. A caller that could not tell them apart would surface an error on
  // every run of every deployment with the feature off.
  it("recognizes the off-deployment refusal through the envelope decoder", () => {
    expect(
      isPoolDisabled({ code: POOL_DISABLED_CODE, message: "set COGNIA_SANDBOX_POOL_ENABLED=1" })
    ).toBe(true)
  })

  it("does not mistake another refusal, or a plain failure, for the pool being off", () => {
    expect(isPoolDisabled({ code: "environment_store_unavailable", message: "no store" })).toBe(
      false
    )
    expect(isPoolDisabled(new Error("network down"))).toBe(false)
    expect(isPoolDisabled(undefined)).toBe(false)
  })
})

describe("declarationReader", () => {
  const result: DeclarationReadResult = {
    files: [
      {
        path: "/repo/.cognia/workspace.json",
        relativePath: ".cognia/workspace.json",
        file: "workspace-config",
        contents: '{"version":1}',
        bytesSha256: "a".repeat(64),
      },
    ],
    searched: [".cognia/workspace.json", ".devcontainer/devcontainer.json", ".devcontainer.json"],
  }

  it("serves a file the Host returned", async () => {
    await expect(declarationReader(result)("/repo", ".cognia/workspace.json", 1000)).resolves.toBe(
      '{"version":1}'
    )
  })

  // The resolver walks its candidates in order and matches a not-found message
  // to mean "try the next one". A reader that rejected differently would turn
  // a repository with only a devcontainer into an unreadable one.
  it("reports a path the Host did not return as not found", async () => {
    await expect(declarationReader(result)("/repo", ".devcontainer.json", 1000)).rejects.toThrow(
      /no such file/
    )
  })

  it("refuses a file over the caller's own limit rather than truncating it", async () => {
    await expect(declarationReader(result)("/repo", ".cognia/workspace.json", 4)).rejects.toThrow(
      /over the 4 limit/
    )
  })

  it("answers everything as absent when the repository declares nothing", async () => {
    const reader = declarationReader({ files: [], searched: [".devcontainer.json"] })
    await expect(reader("/repo", ".devcontainer.json", 1000)).rejects.toThrow(/no such file/)
  })
})

describe("fetchEnvironmentCatalog", () => {
  function pageOf(items: Array<{ id: string }>, nextPageToken?: string): Record<string, unknown> {
    return {
      items: items.map(({ id }) => ({
        entry: { ...entry(), id },
        effectiveFloor: "gvisor",
        defaultEntry: id === "e1",
      })),
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
      rejected: [],
      poolEnabled: true,
      multiTenant: false,
      floor: "container",
      defaultEntryId: "e1",
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
      egressPresets: [{ id: "npm", label: "npm", domains: ["registry.npmjs.org"] }],
      bundle: {
        current: {
          registry: "ghcr.io",
          repository: "cognia/bundle",
          digest: "sha256:x",
          releaseTag: "v2",
        },
        retained: [
          {
            registry: "ghcr.io",
            repository: "cognia/bundle",
            digest: "sha256:y",
            releaseTag: "v1",
          },
        ],
      },
    }
  }

  // The project's own entry may be on any page and so may the default, so
  // resolution needs them all — a resolver handed only the first page would
  // refuse `catalog_entry_unavailable` for an entry that exists.
  it("pages until the Host stops issuing tokens", async () => {
    call
      .mockResolvedValueOnce(pageOf([{ id: "e1" }], "p2") as never)
      .mockResolvedValueOnce(pageOf([{ id: "e2" }]) as never)

    const view = await fetchEnvironmentCatalog(2)

    expect(view.entries.map((e) => e.id)).toEqual(["e1", "e2"])
    expect(call.mock.calls).toEqual([
      ["environment_catalog_list", { pageSize: 2 }],
      ["environment_catalog_list", { pageSize: 2, pageToken: "p2" }],
    ])
  })

  // A Host that kept re-issuing the same token would spin the run path
  // forever. The loop is bounded instead.
  it("stops rather than spinning on a Host that never stops paging", async () => {
    call.mockResolvedValue(pageOf([{ id: "e1" }], "same") as never)
    const view = await fetchEnvironmentCatalog(1)
    expect(view.entries.length).toBe(50)
  })

  it("projects the entry rows and the deployment facts the resolver reads", async () => {
    call.mockResolvedValueOnce(pageOf([{ id: "e1" }]) as never)
    const view = await fetchEnvironmentCatalog()

    expect(view.poolEnabled).toBe(true)
    expect(view.floor).toBe("container")
    expect(view.defaultEntryId).toBe("e1")
    expect(view.entries[0]).toEqual({
      id: "e1",
      scope: "tenant",
      label: "Node 22",
      image: entry().image,
      effectiveFloor: "gvisor",
      sizeClassIds: ["small"],
      source: "manual",
    })
    // `pinned` is the project's answer, never the deployment's: the offer says
    // which bundles exist, and only a project pinning one makes it pinned.
    expect(view.bundle).toEqual({
      current: { digest: "sha256:x", releaseTag: "v2" },
      retained: [{ digest: "sha256:y", releaseTag: "v1" }],
    })
    expect(view.sizeClasses[0]?.id).toBe("small")
    expect(view.egressPresets[0]?.domains).toEqual(["registry.npmjs.org"])
  })

  // The catalog editor writes records back, so it needs them whole —
  // timestamps and provenance included, which the resolver's view drops.
  it("hands the editor every full row, every rejection and the first page's facts", async () => {
    call
      .mockResolvedValueOnce({
        ...pageOf([{ id: "e1" }], "p2"),
        rejected: [{ id: "bad", code: "catalog_size_class_unknown", message: "no" }],
      } as never)
      .mockResolvedValueOnce({ ...pageOf([{ id: "e2" }]), floor: "vm" } as never)

    const { facts, rows, rejected } = await fetchEnvironmentCatalogRows(1)

    expect(rows.map((row) => row.entry)).toEqual([
      { ...entry(), id: "e1" },
      { ...entry(), id: "e2" },
    ])
    expect(rows[0]?.defaultEntry).toBe(true)
    expect(rejected).toEqual([{ id: "bad", code: "catalog_size_class_unknown", message: "no" }])
    expect(facts.floor).toBe("container")
    expect(facts).not.toHaveProperty("items")
    expect(facts).not.toHaveProperty("nextPageToken")
    expect(facts).not.toHaveProperty("rejected")
  })
})

describe("commonImageUser", () => {
  const platform = (user?: string) => ({
    platform: { os: "linux", architecture: "amd64" },
    manifestDigest: "sha256:m",
    configDigest: "sha256:c",
    ...(user === undefined ? {} : { user }),
    env: [],
  })
  const metadata = (...users: Array<string | undefined>) => ({
    registry: "docker.io",
    repository: "library/node",
    digest: "sha256:i",
    mediaType: "application/vnd.oci.image.index.v1+json",
    platforms: users.map(platform),
  })

  it("names the user every platform agrees on", () => {
    expect(commonImageUser(metadata("node", "node"))).toBe("node")
  })

  it("is undefined when every platform runs as root", () => {
    expect(commonImageUser(metadata(undefined, undefined))).toBeUndefined()
  })

  // A catalog entry records ONE image user. Picking the first platform's
  // would make the arm64 sandbox run as a user its image never declared.
  it("is null when the platforms disagree, so an editor can show them", () => {
    expect(commonImageUser(metadata("node", undefined))).toBeNull()
  })
})
