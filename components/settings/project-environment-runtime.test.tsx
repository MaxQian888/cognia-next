import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import type {
  ProjectRuntimeEnvironmentActions,
  ProjectRuntimeEnvironmentState,
  UseProjectRuntimeEnvironmentInput,
} from "@/hooks/sandbox/use-project-runtime-environment"
import type { ProjectEnvironment, ProjectRuntimeSelection } from "@/types/project-environment"
import type { EnvironmentCatalogView } from "@/types/sandbox/environment-catalog"
import en from "@/i18n/messages/en/projectEnvironment.json"

// The hook has its own suite. Here it is a controllable double that records
// what the panel handed it and lets a test drive `save` through `onSave`.
let lastInput: UseProjectRuntimeEnvironmentInput | undefined
let hookState: ProjectRuntimeEnvironmentState
const setDraft = jest.fn((next: ProjectRuntimeSelection | undefined) => {
  hookState = { ...hookState, draft: next }
})
const approve = jest.fn()
const revoke = jest.fn()

jest.mock("@/hooks/sandbox/use-project-runtime-environment", () => {
  const actual = jest.requireActual("@/hooks/sandbox/use-project-runtime-environment")
  return {
    ...actual,
    useProjectRuntimeEnvironment: (
      input: UseProjectRuntimeEnvironmentInput
    ): ProjectRuntimeEnvironmentState & ProjectRuntimeEnvironmentActions => {
      lastInput = input
      return {
        ...hookState,
        setDraft,
        save: async () => {
          await input.onSave(hookState.draft)
        },
        approve,
        revoke,
        grantEgress: jest.fn(),
        reload: jest.fn(),
      }
    },
  }
})

const putMock = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
  putProjectEnvironment: (...args: unknown[]) => putMock(...args),
}))
jest.mock("@/lib/sandbox/run-environment", () => ({
  readRepositoryCoordinates: async () => ({
    remote: "git@github.com:acme/app.git",
    commitSha: "c".repeat(40),
  }),
}))
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (selector: (state: unknown) => unknown) =>
    selector({ projects: [{ id: "prj1", roots: [{ id: "r1", path: "/repo", isPrimary: true }] }] }),
}))

import { compactSelection, ProjectEnvironmentRuntime } from "./project-environment-runtime"

const DIGEST = `sha256:${"a".repeat(64)}`

function catalog(): EnvironmentCatalogView {
  return {
    poolEnabled: true,
    multiTenant: false,
    floor: "container",
    defaultEntryId: "default",
    entries: [
      {
        id: "default",
        scope: "baseline",
        label: "Runner",
        image: { registry: "ghcr.io", repository: "cognia/runner", digest: DIGEST },
        effectiveFloor: "container",
        sizeClassIds: ["small", "gpu"],
        source: "legacy",
      },
    ],
    rejected: [],
    sizeClasses: [
      {
        id: "small",
        label: "Small",
        cpuMillis: 2000,
        memoryMib: 4096,
        ephemeralStorageMib: 1,
        volumeMib: 1,
      },
      {
        id: "gpu",
        label: "GPU",
        cpuMillis: 8000,
        memoryMib: 32768,
        ephemeralStorageMib: 1,
        volumeMib: 1,
        gpu: { count: 1, resourceName: "nvidia.com/gpu" },
      },
    ],
    egressPresets: [{ id: "npm", label: "npm registry", domains: ["registry.npmjs.org"] }],
    bundle: {
      current: { digest: DIGEST, releaseTag: "v2" },
      retained: [{ digest: `sha256:${"b".repeat(64)}`, releaseTag: "v1" }],
    },
  }
}

function state(over: Partial<ProjectRuntimeEnvironmentState> = {}): ProjectRuntimeEnvironmentState {
  return {
    loading: false,
    poolEnabled: true,
    catalog: catalog(),
    driver: {
      driver: "docker",
      deploymentId: "dep",
      instanceId: "inst",
      multiTenant: false,
      isolationFloor: "container",
      availableTiers: ["container"],
      reachable: true,
      bundles: [],
    },
    saved: undefined,
    draft: { source: { kind: "auto" }, updatedAt: 1 },
    declaration: { kind: "absent" },
    approvals: [],
    busy: false,
    ...over,
  }
}

const stored: ProjectEnvironment = {
  id: "env-1",
  projectId: "prj1",
  name: "Node",
  isEnabled: true,
  setupScript: { default: "pnpm install" },
  actions: [],
  variables: { NODE_ENV: "development" },
  keyringReferences: [],
  createdAt: 1,
  updatedAt: 1,
}

beforeEach(() => {
  lastInput = undefined
  hookState = state()
  setDraft.mockClear()
  putMock.mockReset().mockResolvedValue(undefined)
})

function renderPanel(over: Partial<Parameters<typeof ProjectEnvironmentRuntime>[0]> = {}) {
  return render(
    <ProjectEnvironmentRuntime
      projectId="prj1"
      executionRoot="/repo"
      environment={stored}
      {...over}
    />
  )
}

describe("ProjectEnvironmentRuntime", () => {
  it("has nothing to attach a selection to before the environment is saved", () => {
    renderPanel({ environment: undefined })
    expect(screen.getByText(en.runtime.noEnvironment)).toBeInTheDocument()
    expect(screen.queryByTestId("runtime-save")).not.toBeInTheDocument()
  })

  it("hands the hook the stored selection, policy and the checkout's coordinates", async () => {
    renderPanel({
      environment: {
        ...stored,
        runtime: { source: { kind: "auto" }, updatedAt: 4 },
        policy: { requiredRuntimeCapabilities: [], requireSandbox: true },
      },
    })
    await waitFor(() =>
      expect(lastInput?.repository).toEqual({
        remote: "git@github.com:acme/app.git",
        commitSha: "c".repeat(40),
      })
    )
    expect(lastInput?.saved).toEqual({ source: { kind: "auto" }, updatedAt: 4 })
    expect(lastInput?.policy?.requireSandbox).toBe(true)
    expect(lastInput?.project?.roots?.[0]?.path).toBe("/repo")
  })

  // Q39. A deployment that never opted in says so plainly, and keeps the
  // project's choice for when it does.
  it("says the pool is off, and that a saved selection is kept", () => {
    hookState = state({
      poolEnabled: false,
      catalog: undefined,
      driver: undefined,
      saved: hookState.draft,
    })
    renderPanel()
    expect(screen.getByTestId("runtime-pool-off")).toHaveTextContent(en.runtime.poolOff)
    expect(screen.getByTestId("runtime-pool-off")).toHaveTextContent(en.runtime.poolOffKept)
  })

  it("names the driver and the tiers it can provide", () => {
    renderPanel()
    expect(screen.getByTestId("runtime-driver")).toHaveTextContent("Sandbox driver: docker")
    expect(screen.getByTestId("runtime-driver")).toHaveTextContent("Container")
  })

  it("says the driver is unreachable rather than listing no tiers", () => {
    hookState = state({
      driver: {
        ...state().driver!,
        reachable: false,
        availableTiers: [],
        unreachableReason: "no socket",
      },
    })
    renderPanel()
    expect(screen.getByTestId("runtime-driver")).toHaveTextContent(
      "The sandbox driver is unreachable: no socket"
    )
  })

  it("turns the selection off and on through the opt-in switch", () => {
    renderPanel()
    const toggle = screen.getByRole("switch", { name: en.runtime.optIn })
    expect(toggle).toBeChecked()

    fireEvent.click(toggle)
    expect(setDraft).toHaveBeenLastCalledWith(undefined)
  })

  it("hides every selection control while the project has not opted in", () => {
    hookState = state({ draft: undefined })
    renderPanel()
    expect(screen.queryByTestId("runtime-selection")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch", { name: en.runtime.optIn }))
    expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ source: { kind: "auto" } }))
  })

  describe("labels what is not real yet (Rule 7)", () => {
    it("labels egress as recorded but not enforced", () => {
      renderPanel()
      expect(screen.getByText(en.runtime.egressNotEnforced)).toHaveAttribute(
        "data-dormant",
        "egress"
      )
    })

    it("labels credentials as the host's own", () => {
      renderPanel()
      expect(screen.getByText(en.runtime.credentials)).toHaveAttribute(
        "data-dormant",
        "credentials"
      )
    })

    it("labels the local-container toggle as refused on this device", () => {
      const { container } = renderPanel()
      const toggle = container.querySelector('[data-dormant="local-container"]')
      expect(toggle).toHaveTextContent(en.runtime.localContainerDormant)
    })

    it("labels the browser sidecar as not started by this host", () => {
      const { container } = renderPanel()
      expect(container.querySelector('[data-dormant="sidecar"]')).toHaveTextContent(
        en.runtime.sidecarDormant
      )
    })

    // Listed so the size model does not change when GPU sandboxes land, and
    // not selectable, because admission refuses `gpu_not_supported`.
    it("lists a GPU size as unavailable and does not let it be chosen", async () => {
      renderPanel()
      fireEvent.keyDown(screen.getByRole("combobox", { name: en.runtime.size }), { key: "Enter" })

      const gpu = await screen.findByRole("option", {
        name: "GPU — GPU sandboxes are not available yet",
      })
      expect(gpu).toHaveAttribute("aria-disabled", "true")
      expect(gpu).toHaveAttribute("data-dormant", "gpu")
      expect(screen.getByRole("option", { name: "Small · 2 vCPU · 4096 MiB" })).not.toHaveAttribute(
        "aria-disabled",
        "true"
      )
    })

    // The driver attests what it can provide; offering a tier it cannot is
    // offering a run that will be refused.
    it("marks a tier this host cannot provide", async () => {
      renderPanel()
      fireEvent.keyDown(screen.getByRole("combobox", { name: en.runtime.isolation }), {
        key: "Enter",
      })

      expect(
        await screen.findByRole("option", { name: "gVisor — not available on this host" })
      ).toBeInTheDocument()
      expect(screen.getByRole("option", { name: "Container" })).toBeInTheDocument()
    })

    it("writes the local-container request so a run refuses instead of silently ignoring it", () => {
      renderPanel()
      fireEvent.click(screen.getByRole("switch", { name: en.runtime.localContainer }))
      expect(setDraft).toHaveBeenLastCalledWith(expect.objectContaining({ localContainer: true }))
    })
  })

  describe("saving", () => {
    // `environment` is the STORED row: saving the runtime section must not
    // publish unsaved edits made in the editor around it, and must stamp and
    // compact the selection it writes.
    it("writes only the runtime onto the stored row and reports it", async () => {
      const onRuntimeSaved = jest.fn()
      hookState = state({
        draft: {
          source: { kind: "catalog", catalogEntryId: "default" },
          sizeClassId: undefined,
          lifecycle: "ephemeral",
          updatedAt: 1,
        },
      })
      renderPanel({ onRuntimeSaved })

      await act(async () => {
        fireEvent.click(screen.getByTestId("runtime-save"))
      })

      expect(putMock).toHaveBeenCalledTimes(1)
      const written = putMock.mock.calls[0]?.[0] as ProjectEnvironment
      expect(written).toMatchObject({
        id: "env-1",
        name: "Node",
        variables: { NODE_ENV: "development" },
      })
      expect(written.runtime).toEqual({
        source: { kind: "catalog", catalogEntryId: "default" },
        lifecycle: "ephemeral",
        updatedAt: expect.any(Number),
      })
      expect(Object.keys(written.runtime ?? {})).not.toContain("sizeClassId")
      expect(onRuntimeSaved).toHaveBeenCalledWith(written.runtime)
      expect(screen.getByText(en.runtime.saved)).toBeInTheDocument()
    })

    // Opting out writes no selection at all, not a selection that says "none".
    it("removes the runtime key when the project opts out", async () => {
      hookState = state({ draft: undefined })
      renderPanel({
        environment: { ...stored, runtime: { source: { kind: "auto" }, updatedAt: 1 } },
      })

      await act(async () => {
        fireEvent.click(screen.getByTestId("runtime-save"))
      })

      expect(putMock.mock.calls[0]?.[0]).not.toHaveProperty("runtime")
    })
  })

  it("wires the declaration card to the hook's approve and revoke", () => {
    hookState = state({
      approvals: [
        {
          id: "apr1",
          projectId: "prj1",
          normalizedRemote: "github.com/acme/app",
          path: ".devcontainer.json",
          declarationDigest: "d".repeat(64),
          runtimeFieldsDigest: "r".repeat(64),
          approverUserId: "usr",
          via: "hostOwner",
          approvedAt: 1,
        },
      ],
    })
    renderPanel()
    fireEvent.click(
      screen.getByRole("button", { name: "Revoke the approval for .devcontainer.json" })
    )
    expect(revoke).toHaveBeenCalledWith("apr1")
  })

  it("shows a failure the hook reports", () => {
    hookState = state({ error: "approval_authority_insufficient" })
    renderPanel()
    expect(screen.getByRole("alert")).toHaveTextContent("approval_authority_insufficient")
  })
})

describe("compactSelection", () => {
  it("drops cleared keys and keeps everything set", () => {
    expect(
      compactSelection({
        source: { kind: "auto" },
        sizeClassId: undefined,
        browserSidecar: false,
        updatedAt: 3,
      })
    ).toEqual({ source: { kind: "auto" }, browserSidecar: false, updatedAt: 3 })
  })
})
