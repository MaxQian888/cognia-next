/** @jest-environment jsdom */

const client = {
  fetchEnvironmentCatalogRows: jest.fn(),
  environmentDriverStatus: jest.fn(),
  environmentImageInspect: jest.fn(),
  environmentCatalogCreate: jest.fn(),
  environmentCatalogUpdate: jest.fn(),
  environmentCatalogDelete: jest.fn(),
}

jest.mock("@/lib/project-environment/environment-client", () => {
  const actual = jest.requireActual("@/lib/project-environment/environment-client")
  return {
    ...actual,
    fetchEnvironmentCatalogRows: (...args: unknown[]) =>
      client.fetchEnvironmentCatalogRows(...args),
    environmentDriverStatus: (...args: unknown[]) => client.environmentDriverStatus(...args),
    environmentImageInspect: (...args: unknown[]) => client.environmentImageInspect(...args),
    environmentCatalogCreate: (...args: unknown[]) => client.environmentCatalogCreate(...args),
    environmentCatalogUpdate: (...args: unknown[]) => client.environmentCatalogUpdate(...args),
    environmentCatalogDelete: (...args: unknown[]) => client.environmentCatalogDelete(...args),
  }
})

import { act, renderHook, waitFor } from "@testing-library/react"

import { CatalogProblemError, IMAGE_REFERENCE_INVALID, useImageCatalog } from "./use-image-catalog"
import type { CatalogEntryDraft } from "@/lib/project-environment/catalog-entry-draft"
import type {
  CatalogEntryRecord,
  CatalogRows,
  DriverStatus,
} from "@/lib/project-environment/environment-client"

const DIGEST = `sha256:${"a".repeat(64)}`

const problem = (code: string, message = code) => ({ code, message })

function record(overrides: Partial<CatalogEntryRecord> = {}): CatalogEntryRecord {
  return {
    id: "node-22",
    scope: "tenant",
    label: "Node 22",
    image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST },
    isolationFloor: "container",
    sizeClassIds: ["small"],
    source: "manual",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function rows(overrides: Partial<CatalogRows["facts"]> = {}): CatalogRows {
  return {
    facts: {
      poolEnabled: true,
      multiTenant: false,
      floor: "container",
      sizeClasses: [],
      egressPresets: [],
      ...overrides,
    },
    rows: [{ entry: record(), effectiveFloor: "container", defaultEntry: false }],
    rejected: [{ id: "bad", code: "catalog_size_class_unknown", message: "no such class" }],
  }
}

const driver: DriverStatus = {
  driver: "docker",
  deploymentId: "d",
  instanceId: "i",
  multiTenant: false,
  isolationFloor: "container",
  availableTiers: ["container"],
  reachable: true,
  bundles: [],
}

function draft(overrides: Partial<CatalogEntryDraft> = {}): CatalogEntryDraft {
  return {
    id: "node-22",
    label: "Node 22",
    description: "",
    image: {
      registry: "ghcr.io",
      repository: "acme/dev",
      digest: DIGEST,
      user: undefined,
      platforms: [],
    },
    isolationFloor: "container",
    sizeClassIds: ["small"],
    ...overrides,
  }
}

beforeEach(() => {
  for (const mock of Object.values(client)) mock.mockReset()
  client.fetchEnvironmentCatalogRows.mockResolvedValue(rows())
  client.environmentDriverStatus.mockResolvedValue(driver)
  client.environmentCatalogCreate.mockImplementation(async (entry: CatalogEntryRecord) => entry)
  client.environmentCatalogUpdate.mockImplementation(async (entry: CatalogEntryRecord) => entry)
  client.environmentCatalogDelete.mockResolvedValue(record({ revokedAt: 3 }))
})

async function loaded() {
  const hook = renderHook(() => useImageCatalog())
  await waitFor(() => expect(hook.result.current.status).not.toBe("loading"))
  return hook
}

describe("reading the catalog", () => {
  it("reads the entries, the refusals, the facts and the driver together", async () => {
    const { result } = await loaded()
    expect(result.current.status).toBe("ready")
    expect(result.current.rows.map((row) => row.entry.id)).toEqual(["node-22"])
    expect(result.current.rejected[0]?.code).toBe("catalog_size_class_unknown")
    expect(result.current.facts?.floor).toBe("container")
    expect(result.current.driver).toEqual(driver)
    expect(result.current.loadProblem).toBeUndefined()
  })

  // Q39: a deployment that never opted in is a state, not an error.
  it("reads a deployment with the pool off as off, not as a failure", async () => {
    client.fetchEnvironmentCatalogRows.mockRejectedValue(problem("sandbox_pool_disabled"))
    client.environmentDriverStatus.mockRejectedValue(problem("sandbox_pool_disabled"))
    const { result } = await loaded()
    expect(result.current.status).toBe("pool-off")
    expect(result.current.loadProblem).toBeUndefined()
    expect(result.current.driverProblem).toBeUndefined()
  })

  it("reads a catalog that says the switch is off as off", async () => {
    client.fetchEnvironmentCatalogRows.mockResolvedValue(rows({ poolEnabled: false }))
    const { result } = await loaded()
    expect(result.current.status).toBe("pool-off")
  })

  it("reports a catalog it could not read, with the Host's code", async () => {
    client.fetchEnvironmentCatalogRows.mockRejectedValue(problem("forbidden", "admin only"))
    const { result } = await loaded()
    expect(result.current.status).toBe("failed")
    expect(result.current.loadProblem).toEqual({ code: "forbidden", message: "admin only" })
  })

  // The catalog is still worth showing when only the driver is down.
  it("keeps the catalog when only the driver cannot be asked", async () => {
    client.environmentDriverStatus.mockRejectedValue(problem("upstream_unavailable", "down"))
    const { result } = await loaded()
    expect(result.current.status).toBe("ready")
    expect(result.current.driver).toBeUndefined()
    expect(result.current.driverProblem).toEqual({ code: "upstream_unavailable", message: "down" })
  })

  it("does not let an older read overwrite a newer one", async () => {
    const { result } = await loaded()
    let releaseOld: (value: CatalogRows) => void = () => {}
    client.fetchEnvironmentCatalogRows
      .mockImplementationOnce(() => new Promise<CatalogRows>((resolve) => (releaseOld = resolve)))
      .mockResolvedValueOnce({ ...rows(), rows: [] })

    let first: Promise<void> = Promise.resolve()
    await act(async () => {
      first = result.current.reload()
      await result.current.reload()
    })
    expect(result.current.rows).toEqual([])
    await act(async () => {
      releaseOld(rows())
      await first
    })
    expect(result.current.rows).toEqual([])
  })
})

describe("inspect", () => {
  it("resolves a tag to the digest and user the registry reports", async () => {
    client.environmentImageInspect.mockResolvedValue({
      registry: "docker.io",
      repository: "library/node",
      digest: DIGEST,
      mediaType: "application/vnd.oci.image.index.v1+json",
      platforms: [
        {
          platform: { os: "linux", architecture: "amd64" },
          manifestDigest: "sha256:m1",
          configDigest: "sha256:c1",
          user: "node",
          env: [],
        },
        {
          platform: { os: "linux", architecture: "arm64", variant: "v8" },
          manifestDigest: "sha256:m2",
          configDigest: "sha256:c2",
          user: "node",
          env: [],
        },
      ],
    })
    const { result } = await loaded()

    let resolved
    await act(async () => {
      resolved = await result.current.inspect(" node:22 ")
    })
    // Normalized before it reaches the Host, exactly as an approval is.
    expect(client.environmentImageInspect).toHaveBeenCalledWith("docker.io/library/node:22")
    expect(resolved).toEqual({
      registry: "docker.io",
      repository: "library/node",
      digest: DIGEST,
      tag: "22",
      user: "node",
      platforms: ["linux/amd64", "linux/arm64/v8"],
    })
  })

  it("refuses a reference it cannot parse without asking the Host", async () => {
    const { result } = await loaded()
    let caught: unknown
    await act(async () => {
      caught = await result.current.inspect("UPPER CASE").catch((error) => error)
    })
    expect(caught).toBeInstanceOf(CatalogProblemError)
    expect((caught as CatalogProblemError).problem.code).toBe(IMAGE_REFERENCE_INVALID)
    expect(client.environmentImageInspect).not.toHaveBeenCalled()
  })

  it("passes on the Host's refusal with its code", async () => {
    client.environmentImageInspect.mockRejectedValue(
      problem("catalog_registry_not_allowlisted", "evil.io is not allowed")
    )
    const { result } = await loaded()
    let caught: unknown
    await act(async () => {
      caught = await result.current.inspect("evil.io/x:1").catch((error) => error)
    })
    expect((caught as CatalogProblemError).problem).toEqual({
      code: "catalog_registry_not_allowlisted",
      message: "evil.io is not allowed",
    })
  })
})

describe("writing", () => {
  it("creates a new entry, then reads the catalog again", async () => {
    const { result } = await loaded()
    client.fetchEnvironmentCatalogRows.mockClear()

    let outcome
    await act(async () => {
      outcome = await result.current.save(draft())
    })
    expect(outcome).toEqual({ ok: true })
    expect(client.environmentCatalogCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id: "node-22", scope: "tenant", source: "manual" })
    )
    expect(client.environmentCatalogUpdate).not.toHaveBeenCalled()
    expect(client.fetchEnvironmentCatalogRows).toHaveBeenCalledTimes(1)
    expect(result.current.busy).toBe(false)
  })

  it("updates an existing entry, keeping what the editor does not own", async () => {
    const { result } = await loaded()
    const existing = record({ source: "build", createdAt: 5 })
    await act(async () => {
      await result.current.save(draft({ label: "Renamed" }), existing)
    })
    expect(client.environmentCatalogUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ label: "Renamed", source: "build", createdAt: 5 })
    )
    expect(client.environmentCatalogCreate).not.toHaveBeenCalled()
  })

  it("returns the Host's refusal and leaves the catalog as it was", async () => {
    client.environmentCatalogCreate.mockRejectedValue(
      problem("catalog_entry_duplicate", "a tenant entry with id node-22 exists")
    )
    const { result } = await loaded()
    client.fetchEnvironmentCatalogRows.mockClear()

    let outcome
    await act(async () => {
      outcome = await result.current.save(draft())
    })
    expect(outcome).toEqual({
      ok: false,
      problem: {
        code: "catalog_entry_duplicate",
        message: "a tenant entry with id node-22 exists",
      },
    })
    expect(client.fetchEnvironmentCatalogRows).not.toHaveBeenCalled()
    expect(result.current.busy).toBe(false)
  })

  it("never sends a draft the Host would refuse as malformed", async () => {
    const { result } = await loaded()
    let outcome
    await act(async () => {
      outcome = await result.current.save(draft({ image: undefined }))
    })
    expect(outcome).toEqual({ ok: false, problem: { code: "image_unresolved", message: "image" } })
    expect(client.environmentCatalogCreate).not.toHaveBeenCalled()
  })

  it("revokes an entry", async () => {
    const { result } = await loaded()
    let outcome
    await act(async () => {
      outcome = await result.current.revoke("node-22")
    })
    expect(outcome).toEqual({ ok: true })
    expect(client.environmentCatalogDelete).toHaveBeenCalledWith("node-22")
  })

  it("returns a refused revocation", async () => {
    client.environmentCatalogDelete.mockRejectedValue(problem("environment_record_not_found"))
    const { result } = await loaded()
    let outcome
    await act(async () => {
      outcome = await result.current.revoke("gone")
    })
    expect(outcome).toEqual({
      ok: false,
      problem: { code: "environment_record_not_found", message: "environment_record_not_found" },
    })
  })
})
