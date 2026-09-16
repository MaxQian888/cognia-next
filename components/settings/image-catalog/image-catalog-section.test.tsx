import { act, fireEvent, render, screen, within } from "@testing-library/react"

import type {
  CatalogWriteResult,
  ImageCatalogActions,
  ImageCatalogState,
} from "@/hooks/sandbox/use-image-catalog"
import type {
  CatalogEntryRecord,
  CatalogEntryRow,
} from "@/lib/project-environment/environment-client"
import en from "@/i18n/messages/en/settings/imageCatalog.json"

// The hook has its own suite; here it is a double the test drives.
let hookState: ImageCatalogState
const reload = jest.fn(async () => {})
const revoke = jest.fn(async (): Promise<CatalogWriteResult> => ({ ok: true }))
const save = jest.fn(async (): Promise<CatalogWriteResult> => ({ ok: true }))
const inspect = jest.fn()

jest.mock("@/hooks/sandbox/use-image-catalog", () => ({
  ...jest.requireActual("@/hooks/sandbox/use-image-catalog"),
  useImageCatalog: (): ImageCatalogState & ImageCatalogActions => ({
    ...hookState,
    reload,
    revoke,
    save,
    inspect,
  }),
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({ toast: { success: (...args: unknown[]) => toastSuccess(...args) } }))

import { ImageCatalogSection } from "./image-catalog-section"

const DIGEST = `sha256:${"a".repeat(64)}`

function entry(overrides: Partial<CatalogEntryRecord> = {}): CatalogEntryRecord {
  return {
    id: "node-22",
    scope: "tenant",
    label: "Node 22",
    image: { registry: "ghcr.io", repository: "acme/dev", digest: DIGEST, tag: "22" },
    isolationFloor: "container",
    sizeClassIds: ["small"],
    imageUser: "node",
    source: "manual",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function row(
  record: CatalogEntryRecord,
  overrides: Partial<CatalogEntryRow> = {}
): CatalogEntryRow {
  return { entry: record, effectiveFloor: "gvisor", defaultEntry: false, ...overrides }
}

function ready(overrides: Partial<ImageCatalogState> = {}): ImageCatalogState {
  return {
    status: "ready",
    facts: {
      poolEnabled: true,
      multiTenant: true,
      floor: "gvisor",
      defaultEntryId: "default",
      sizeClasses: [
        {
          id: "small",
          label: "Small",
          cpuMillis: 2000,
          memoryMib: 4096,
          ephemeralStorageMib: 8192,
          volumeMib: 20480,
        },
        {
          id: "gpu",
          label: "GPU",
          cpuMillis: 8000,
          memoryMib: 32768,
          ephemeralStorageMib: 1,
          volumeMib: 1,
          gpu: { count: 2, resourceName: "nvidia.com/gpu" },
        },
      ],
      egressPresets: [{ id: "npm", label: "npm", domains: ["registry.npmjs.org"] }],
      bundle: {
        current: {
          registry: "ghcr.io",
          repository: "cognia/bundle",
          digest: DIGEST,
          releaseTag: "v2.0.0",
        },
        retained: [
          {
            registry: "ghcr.io",
            repository: "cognia/bundle",
            digest: DIGEST,
            releaseTag: "v1.9.0",
          },
        ],
      },
    },
    rows: [
      row(
        entry({
          id: "default",
          scope: "baseline",
          label: "Default runner",
          image: { registry: "docker.io", repository: "cognia/runner", tag: "latest" },
          imageUser: undefined,
          source: "legacy",
        }),
        { defaultEntry: true, effectiveFloor: "gvisor" }
      ),
      row(entry()),
    ],
    rejected: [],
    driver: {
      driver: "docker",
      deploymentId: "d",
      instanceId: "i",
      multiTenant: true,
      isolationFloor: "gvisor",
      availableTiers: ["container", "gvisor"],
      reachable: true,
      bundles: [],
    },
    busy: false,
    ...overrides,
  }
}

beforeEach(() => {
  hookState = ready()
  for (const mock of [reload, revoke, save, inspect, toastSuccess]) mock.mockClear()
})

describe("ImageCatalogSection", () => {
  it("says it is reading while the catalog loads", () => {
    hookState = { status: "loading", rows: [], rejected: [], busy: false }
    render(<ImageCatalogSection />)
    expect(screen.getByText(en.loading)).toBeInTheDocument()
    expect(screen.queryByText(en.entries.title)).not.toBeInTheDocument()
  })

  // Q39: a deployment that never opted in says so and offers nothing.
  it("explains a deployment with runtime environments off, and offers nothing", () => {
    hookState = { status: "pool-off", rows: [], rejected: [], busy: false }
    render(<ImageCatalogSection />)
    expect(screen.getByTestId("image-catalog-pool-off")).toHaveTextContent(en.poolOff.title)
    expect(screen.queryByRole("button", { name: en.entries.add })).not.toBeInTheDocument()
  })

  it("shows why the catalog could not be read", () => {
    hookState = {
      status: "failed",
      rows: [],
      rejected: [],
      busy: false,
      loadProblem: { code: "forbidden", message: "admin only" },
    }
    render(<ImageCatalogSection />)
    expect(screen.getByText(en.failed)).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveTextContent(en.errors.forbidden)
  })

  it("states the deployment facts entries are read against", () => {
    render(<ImageCatalogSection />)
    const facts = screen.getByTestId("image-catalog-facts")
    expect(facts).toHaveTextContent("Minimum isolation: gVisor")
    expect(facts).toHaveTextContent(en.facts.multiTenant)
    expect(facts).toHaveTextContent("Sandbox driver: docker · Reachable")
    expect(facts).toHaveTextContent("Isolation available: Container, gVisor")
  })

  it("says why the driver is unreachable, and still lists the catalog", () => {
    hookState = ready({
      driver: { ...ready().driver!, reachable: false, unreachableReason: "socket closed" },
    })
    render(<ImageCatalogSection />)
    expect(screen.getByTestId("image-catalog-facts")).toHaveTextContent(
      "Unreachable: socket closed"
    )
    expect(screen.getByTestId("catalog-entry-node-22")).toBeInTheDocument()
  })

  it("reports a driver that could not be asked", () => {
    hookState = ready({
      driver: undefined,
      driverProblem: { code: "upstream_unavailable", message: "x" },
    })
    render(<ImageCatalogSection />)
    expect(screen.getByText(en.facts.driverProblem)).toBeInTheDocument()
  })

  it("lists baseline images read-only and tenant images editable", () => {
    render(<ImageCatalogSection />)
    const baseline = screen.getByTestId("catalog-entry-default")
    expect(baseline).toHaveTextContent("Default runner")
    expect(baseline).toHaveTextContent(en.entries.scope.baseline)
    expect(baseline).toHaveTextContent(en.entries.default)
    expect(baseline).toHaveTextContent(en.entries.source.legacy)
    // A tag-only legacy entry is listed and said to be unused.
    expect(baseline).toHaveTextContent("docker.io/cognia/runner:latest")
    expect(baseline).toHaveTextContent(en.entries.unpinned)
    expect(baseline).toHaveTextContent(en.entries.userRoot)
    expect(within(baseline).queryByRole("button")).not.toBeInTheDocument()

    const tenant = screen.getByTestId("catalog-entry-node-22")
    expect(tenant).toHaveTextContent(`ghcr.io/acme/dev:22@${DIGEST}`)
    expect(tenant).toHaveTextContent("Isolation at least gVisor")
    expect(tenant).toHaveTextContent("Runs as node")
    expect(tenant).toHaveTextContent("Sizes: Small")
    expect(within(tenant).getByRole("button", { name: "Edit Node 22" })).toBeEnabled()
    expect(within(tenant).getByRole("button", { name: "Revoke Node 22" })).toBeEnabled()
  })

  it("says so when there are no images", () => {
    hookState = ready({ rows: [] })
    render(<ImageCatalogSection />)
    expect(screen.getByText(en.entries.empty)).toBeInTheDocument()
  })

  it("lists the tenant images the baseline refused, with the reason", () => {
    hookState = ready({
      rejected: [{ id: "evil", code: "catalog_registry_not_allowlisted", message: "evil.io" }],
    })
    render(<ImageCatalogSection />)
    const card = screen.getByTestId("image-catalog-rejected")
    expect(card).toHaveTextContent("evil")
    expect(card).toHaveTextContent(en.errors.catalogRegistryNotAllowlisted)
  })

  // Working Rule 7, both labels this page carries.
  it("labels GPU sizes and network presets as not yet real", () => {
    render(<ImageCatalogSection />)
    expect(
      screen.getByText(/GPU \(2 × nvidia.com\/gpu\): GPU sandboxes are not available yet/)
    ).toHaveAttribute("data-dormant", "gpu")
    expect(screen.getByText(en.egress.notEnforced)).toHaveAttribute("data-dormant", "egress")
    expect(screen.getByText("registry.npmjs.org")).toBeInTheDocument()
  })

  it("shows the agent bundle on offer", () => {
    render(<ImageCatalogSection />)
    expect(screen.getByText("Current release: v2.0.0")).toBeInTheDocument()
    expect(
      screen.getByText("Still available to projects that pinned them: v1.9.0")
    ).toBeInTheDocument()
  })

  it("says nothing can be sandboxed without a bundle", () => {
    const base = ready()
    hookState = ready({ facts: { ...base.facts!, bundle: undefined } })
    render(<ImageCatalogSection />)
    expect(screen.getByText(en.bundle.none)).toBeInTheDocument()
  })

  it("cannot add an image when the baseline offers no usable size", () => {
    const base = ready()
    hookState = ready({
      facts: { ...base.facts!, sizeClasses: base.facts!.sizeClasses.filter((s) => s.gpu) },
    })
    render(<ImageCatalogSection />)
    expect(screen.getByRole("button", { name: en.entries.add })).toBeDisabled()
  })

  it("opens the editor to add an image and to edit one", () => {
    render(<ImageCatalogSection />)
    fireEvent.click(screen.getByRole("button", { name: en.entries.add }))
    expect(screen.getByRole("heading", { name: en.editor.createTitle })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: en.editor.cancel }))

    fireEvent.click(screen.getByRole("button", { name: "Edit Node 22" }))
    expect(screen.getByRole("heading", { name: "Edit Node 22" })).toBeInTheDocument()
    expect(screen.getByLabelText(en.editor.id)).toHaveValue("node-22")
  })

  it("revokes a tenant image after confirming", async () => {
    render(<ImageCatalogSection />)
    fireEvent.click(screen.getByRole("button", { name: "Revoke Node 22" }))
    const dialog = screen.getByRole("alertdialog")
    expect(dialog).toHaveTextContent("Revoke Node 22?")
    expect(dialog).toHaveTextContent("the ID node-22 cannot be used again")

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: en.revoke.confirm }))
    })
    expect(revoke).toHaveBeenCalledWith("node-22")
    expect(toastSuccess).toHaveBeenCalledWith("Node 22 was revoked.")
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("keeps the confirmation open and says why a revocation was refused", async () => {
    revoke.mockResolvedValueOnce({
      ok: false,
      problem: { code: "forbidden", message: "host.admin required" },
    })
    render(<ImageCatalogSection />)
    fireEvent.click(screen.getByRole("button", { name: "Revoke Node 22" }))
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.revoke.confirm }))
    })
    const dialog = screen.getByRole("alertdialog")
    expect(within(dialog).getByRole("alert")).toHaveTextContent(en.errors.forbidden)
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("does not revoke when the person cancels", () => {
    render(<ImageCatalogSection />)
    fireEvent.click(screen.getByRole("button", { name: "Revoke Node 22" }))
    fireEvent.click(screen.getByRole("button", { name: en.revoke.cancel }))
    expect(revoke).not.toHaveBeenCalled()
  })

  it("reloads on request", () => {
    render(<ImageCatalogSection />)
    fireEvent.click(screen.getByRole("button", { name: en.reload }))
    expect(reload).toHaveBeenCalled()
  })

  it("disables writes while one is in flight", () => {
    hookState = ready({ busy: true })
    render(<ImageCatalogSection />)
    expect(screen.getByRole("button", { name: en.entries.add })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Revoke Node 22" })).toBeDisabled()
    expect(screen.getByRole("button", { name: en.reload })).toBeDisabled()
  })
})
