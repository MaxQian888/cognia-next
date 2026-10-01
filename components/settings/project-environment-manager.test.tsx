import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const listMock = jest.fn()
const putMock = jest.fn()
const deleteMock = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
  ...jest.requireActual("@/lib/db/project-environments"),
  listProjectEnvironments: (...args: unknown[]) => listMock(...args),
  putProjectEnvironment: (...args: unknown[]) => putMock(...args),
  deleteProjectEnvironment: (...args: unknown[]) => deleteMock(...args),
}))
const executeMock = jest.fn()
jest.mock("@/lib/project-environment/executor", () => ({
  executeProjectEnvironment: (...args: unknown[]) => executeMock(...args),
}))
const updateProjectMock = jest.fn()
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({ projects: [{ id: "project-1" }] }),
    { getState: () => ({ updateProject: updateProjectMock }) }
  ),
}))

// The runtime panel has its own suite. Here it is a probe: which row the
// editor hands it, and what the editor does with the selection it saves.
const runtimeProps: Array<{
  environment?: { id: string; name: string; runtime?: unknown }
  onRuntimeSaved?: (runtime: unknown) => void
}> = []
jest.mock("./project-environment-runtime", () => ({
  ProjectEnvironmentRuntime: (props: (typeof runtimeProps)[number]) => {
    runtimeProps.push(props)
    return <div data-testid="runtime-probe" />
  },
}))

// The gate has its own suite; here it records what it was asked to gate on
// and lets a test decide whether this host runs the sandbox pool.
let poolHost = true
const gatedOn: Array<string | undefined> = []
jest.mock("@/components/platform/capability-gate", () => ({
  CapabilityGate: ({
    capability,
    explain,
    children,
  }: {
    capability?: string
    explain?: boolean
    children: React.ReactNode
  }) => {
    gatedOn.push(capability)
    if (poolHost) return <>{children}</>
    return explain ? <div data-testid="capability-notice">{capability}</div> : null
  },
}))

import { act } from "react"
import { ProjectEnvironmentManager } from "./project-environment-manager"

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([])
  putMock.mockReset().mockResolvedValue(undefined)
  deleteMock.mockReset().mockResolvedValue(undefined)
  executeMock.mockReset().mockResolvedValue({ success: true, bypassed: false })
  updateProjectMock.mockReset()
  runtimeProps.length = 0
  poolHost = true
  gatedOn.length = 0
})

it("creates a project environment with plain variables and keyring references", async () => {
  const onSelected = jest.fn()
  render(
    <ProjectEnvironmentManager
      projectId="project-1"
      executionRoot="/repo"
      scope="local"
      onSelectedEnvironmentChange={onSelected}
    />
  )
  await waitFor(() => expect(listMock).toHaveBeenCalledWith("project-1"))
  fireEvent.click(screen.getByRole("button", { name: /New environment/ }))
  fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Node" } })
  fireEvent.change(screen.getByLabelText("Setup script"), { target: { value: "pnpm install" } })
  fireEvent.click(screen.getByRole("button", { name: "Add variable" }))
  fireEvent.change(screen.getByLabelText("Variable name"), { target: { value: "NODE_ENV" } })
  fireEvent.change(screen.getByLabelText("Plain value"), { target: { value: "development" } })
  fireEvent.click(screen.getByRole("button", { name: "Add keyring reference" }))
  fireEvent.change(screen.getAllByLabelText("Variable name")[1], {
    target: { value: "TOKEN" },
  })
  fireEvent.change(screen.getByLabelText("namespace:credential reference"), {
    target: { value: "github:pat" },
  })
  fireEvent.click(screen.getByRole("checkbox", { name: "Use as project default" }))
  fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
  await waitFor(() => expect(putMock).toHaveBeenCalled())
  expect(putMock).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "project-1",
      name: "Node",
      variables: { NODE_ENV: "development" },
      keyringReferences: [{ variable: "TOKEN", keyringRef: "github:pat" }],
    })
  )
  expect(updateProjectMock).toHaveBeenCalledWith(
    "project-1",
    expect.objectContaining({ defaultEnvironmentId: expect.any(String) })
  )
  expect(onSelected).toHaveBeenCalled()
})

it("renders a stored row that predates the variables / keyring fields", async () => {
  // Dexie rows are not schema-validated on read. A row written before either
  // array existed used to throw inside the selection handler and blank the
  // whole settings panel.
  listMock.mockResolvedValue([
    { id: "env-legacy", projectId: "project-1", name: "Legacy", updatedAt: 1 },
  ])
  render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)

  await waitFor(() => expect(listMock).toHaveBeenCalled())
  expect(await screen.findByDisplayValue("Legacy")).toBeInTheDocument()
})

describe("the runtime environment section", () => {
  const stored = {
    id: "env-1",
    projectId: "project-1",
    name: "Stored name",
    isEnabled: true,
    setupScript: { default: "" },
    actions: [],
    variables: {},
    keyringReferences: [],
    createdAt: 1,
    updatedAt: 1,
  }

  // ADR-0182: only a host that runs the sandbox pool can act on a selection.
  // Anywhere else the section explains itself instead of offering a choice
  // that every run would refuse.
  it("explains itself on a host without the sandbox pool", async () => {
    poolHost = false
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByDisplayValue("Stored name")

    expect(screen.getByTestId("capability-notice")).toHaveTextContent("sandbox-pool")
    expect(screen.queryByTestId("runtime-probe")).not.toBeInTheDocument()
    expect(gatedOn).toContain("sandbox-pool")
  })

  // The runtime section saves on its own. Handing it the editor's working
  // copy would let that save publish every unsaved edit above it.
  it("is given the stored row, not the working copy", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByDisplayValue("Stored name")

    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Unsaved" } })

    await waitFor(() => expect(runtimeProps.at(-1)?.environment?.name).toBe("Stored name"))
  })

  it("has no row to attach a selection to for an environment never saved", async () => {
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await waitFor(() => expect(listMock).toHaveBeenCalled())
    fireEvent.click(screen.getByRole("button", { name: /New environment/ }))

    await waitFor(() => expect(runtimeProps.at(-1)).toBeDefined())
    expect(runtimeProps.at(-1)?.environment).toBeUndefined()
  })

  // Otherwise the editor's own save writes the OLD selection back over the
  // one the section just stored.
  it("carries a saved selection into the editor's next save, keeping unsaved edits", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByDisplayValue("Stored name")
    fireEvent.change(screen.getByLabelText("Environment name"), { target: { value: "Edited" } })

    const runtime = { source: { kind: "auto" }, updatedAt: 9 }
    act(() => runtimeProps.at(-1)?.onRuntimeSaved?.(runtime))
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))

    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "env-1", name: "Edited", runtime })
    )
  })

  it("drops the selection from the editor when the section turns it off", async () => {
    listMock.mockResolvedValue([{ ...stored, runtime: { source: { kind: "auto" }, updatedAt: 3 } }])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByDisplayValue("Stored name")

    act(() => runtimeProps.at(-1)?.onRuntimeSaved?.(undefined))
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))

    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock.mock.calls.at(-1)?.[0]).not.toHaveProperty("runtime")
  })
})

describe("setup reuse", () => {
  const stored = {
    id: "env-1",
    projectId: "project-1",
    name: "Node",
    isEnabled: true,
    setupScript: { default: "pnpm install" },
    actions: [],
    variables: {},
    keyringReferences: [],
    createdAt: 1,
    updatedAt: 1,
  }

  it("saves a reuse declaration with blank lines dropped", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByDisplayValue("Node")

    fireEvent.click(screen.getByRole("switch", { name: "Reuse setup when nothing changed" }))
    fireEvent.change(screen.getByLabelText("Input files (one per line)"), {
      target: { value: "pnpm-lock.yaml\n\n" },
    })
    fireEvent.change(screen.getByLabelText("Required outputs (one per line)"), {
      target: { value: " node_modules " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))

    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock).toHaveBeenCalledWith(
      expect.objectContaining({
        setupReuse: { enabled: true, inputs: ["pnpm-lock.yaml"], outputs: ["node_modules"] },
      })
    )
  })

  it("saves an environment that never opted in without a declaration", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByDisplayValue("Node")

    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))

    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock.mock.calls[0][0]).not.toHaveProperty("setupReuse")
  })

  it("translates bootstrap validation from a manual initialization result", async () => {
    executeMock.mockResolvedValueOnce({
      success: false,
      bypassed: false,
      error: "Invalid bootstrap Agent configuration: checks",
      bootstrapValidationCode: "checks",
    })
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByDisplayValue("Node")
    fireEvent.click(screen.getByRole("button", { name: "Run setup" }))
    await waitFor(() => expect(executeMock).toHaveBeenCalled())
    expect(screen.queryByText(/Invalid bootstrap Agent configuration/)).not.toBeInTheDocument()
    expect(screen.getByText(/readiness check/i)).toBeInTheDocument()
  })

  it("forces a manual setup run but not an action", async () => {
    listMock.mockResolvedValue([
      { ...stored, actions: [{ id: "test", name: "Test", script: { default: "pnpm test" } }] },
    ])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByDisplayValue("Node")

    fireEvent.click(screen.getByRole("button", { name: "Run setup" }))
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(1))
    expect(executeMock).toHaveBeenLastCalledWith(expect.objectContaining({ force: true }))

    fireEvent.click(screen.getByRole("button", { name: "Run Test" }))
    await waitFor(() => expect(executeMock).toHaveBeenCalledTimes(2))
    expect(executeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionId: "test", force: false })
    )
  })
})

describe("bootstrap Agent settings", () => {
  const agent = {
    enabled: true,
    task: "Prepare environment",
    baseUrl: "https://api.example.com/v1",
    model: "bootstrap-model",
    checks: [{ name: "ready", command: "true" }],
  }
  const stored = {
    id: "env-bootstrap",
    projectId: "project-1",
    name: "Bootstrap",
    isEnabled: true,
    setupScript: { default: "" },
    actions: [],
    variables: {},
    keyringReferences: [{ variable: "COGNIA_BOOTSTRAP_API_KEY", keyringRef: "provider:key" }],
    bootstrapAgent: agent,
    createdAt: 1,
    updatedAt: 1,
  }

  it("mounts the bootstrap section and saves edits with keyring references", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    expect(await screen.findByLabelText("Initialization task")).toHaveValue("Prepare environment")
    fireEvent.change(screen.getByLabelText("Bootstrap model"), {
      target: { value: "updated-model" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock.mock.calls.at(-1)[0]).toMatchObject({
      bootstrapAgent: { ...agent, model: "updated-model" },
      keyringReferences: stored.keyringReferences,
    })
  })

  it("preserves optional configuration when disabled and saved", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByLabelText("Initialization task")
    fireEvent.click(
      screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock.mock.calls.at(-1)[0]).toMatchObject({
      bootstrapAgent: { ...agent, enabled: false },
    })
  })

  it("saves recipe setup and readiness settings together without executing them", async () => {
    listMock.mockResolvedValue([
      { ...stored, setupScript: { default: "old setup", byOs: { windows: "old override" } } },
    ])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByLabelText("Initialization recipe")
    fireEvent.change(screen.getByLabelText("Initialization recipe"), {
      target: { value: "node-pnpm" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply recipe" }))
    expect(executeMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock.mock.calls.at(-1)[0].setupScript).toEqual({
      default: "pnpm install --frozen-lockfile",
      byOs: {},
    })
    expect(putMock.mock.calls.at(-1)[0]).toMatchObject({
      setupScript: { default: "pnpm install --frozen-lockfile", byOs: {} },
      bootstrapAgent: {
        checks: [{ name: "dependencies", command: "test -d node_modules" }],
        reuse: { inputs: ["package.json", "pnpm-lock.yaml"], outputs: ["node_modules"] },
        commandTimeoutSecs: 300,
        totalTimeoutSecs: 900,
      },
    })
  })

  it("persists provider changes without retaining earlier authentication headers", async () => {
    listMock.mockResolvedValue([
      {
        ...stored,
        bootstrapAgent: {
          ...agent,
          runtime: "bash",
          binary: "/custom/bootstrap.sh",
          modelOptions: {
            auth: "header",
            apiKeyHeader: "X-Old-Key",
            headersEnv: { "X-Old-Token": "OLD_TOKEN" },
            extraBody: { oldProvider: true },
          },
        },
      },
    ])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByLabelText("Provider preset")
    fireEvent.change(screen.getByLabelText("Provider preset"), { target: { value: "ollama" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply provider" }))
    fireEvent.change(screen.getByLabelText("Bootstrap model"), {
      target: { value: "installed-model" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock.mock.calls.at(-1)[0].bootstrapAgent).toMatchObject({
      runtime: "bash",
      binary: "/custom/bootstrap.sh",
      baseUrl: "http://localhost:11434/v1",
      model: "installed-model",
    })
    expect(putMock.mock.calls.at(-1)[0].bootstrapAgent.modelOptions).toEqual({ auth: "none" })
    expect(executeMock).not.toHaveBeenCalled()
  })

  it("shows translated validation and refuses saving an empty readiness check", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByLabelText("Initialization task")
    fireEvent.change(screen.getByLabelText("Readiness check command"), { target: { value: "" } })
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
    expect(await screen.findByText(/Add 1–32 checks with unique names/)).toBeInTheDocument()
    expect(putMock).not.toHaveBeenCalled()
  })

  it("blocks saving an invalid advanced draft instead of publishing stale options", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByLabelText("Initialization task")
    fireEvent.change(screen.getByLabelText("Advanced configuration JSON"), {
      target: { value: '{"tools":' },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
    await waitFor(() =>
      expect(
        screen.getAllByText(/Correct the advanced JSON and model options/).length
      ).toBeGreaterThan(0)
    )
    expect(putMock).not.toHaveBeenCalled()
  })

  it("retains invalid JSON after manual initialization validation and preserves it when disabled", async () => {
    listMock.mockResolvedValue([stored])
    executeMock.mockResolvedValue({
      success: false,
      bypassed: false,
      bootstrapValidationCode: "options",
    })
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByLabelText("Initialization task")
    const editor = screen.getByLabelText("Advanced configuration JSON")
    fireEvent.change(editor, { target: { value: '{"tools":' } })
    fireEvent.click(screen.getByRole("button", { name: "Run setup" }))
    await waitFor(() => expect(executeMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByRole("button", { name: "Run setup" })).toBeEnabled())
    expect(editor).toHaveValue('{"tools":')
    expect(listMock).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole("switch", { name: "Use a bootstrap Agent for initialization" })
    )
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock.mock.calls.at(-1)[0]).toMatchObject({
      bootstrapAgent: { enabled: false, advancedOptionsDraft: '{"tools":' },
    })
  })

  it("uses current credential references and plain variables for a manual initialization", async () => {
    listMock.mockResolvedValue([stored])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByLabelText("Initialization task")
    fireEvent.change(screen.getByLabelText("namespace:credential reference"), {
      target: { value: "provider:updated" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }))
    fireEvent.change(screen.getAllByLabelText("Variable name")[0], { target: { value: "LANG" } })
    fireEvent.change(screen.getByLabelText("Plain value"), { target: { value: "C" } })
    fireEvent.click(screen.getByRole("button", { name: "Run setup" }))
    await waitFor(() => expect(executeMock).toHaveBeenCalled())
    expect(executeMock.mock.calls.at(-1)[0].environment).toMatchObject({
      variables: { LANG: "C" },
      keyringReferences: [{ variable: "COGNIA_BOOTSTRAP_API_KEY", keyringRef: "provider:updated" }],
    })
    expect(putMock).not.toHaveBeenCalled()
  })

  it("saves a customized local provider without requiring an API key", async () => {
    listMock.mockResolvedValue([{ ...stored, keyringReferences: [] }])
    render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
    await screen.findByLabelText("Initialization task")
    fireEvent.change(screen.getByLabelText("Model API endpoint"), {
      target: { value: "http://localhost:11434/v1" },
    })
    fireEvent.change(screen.getByLabelText("Authentication"), { target: { value: "none" } })
    fireEvent.change(screen.getByLabelText("Maximum response tokens"), {
      target: { value: "2048" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
    await waitFor(() => expect(putMock).toHaveBeenCalled())
    expect(putMock.mock.calls.at(-1)[0]).toMatchObject({
      keyringReferences: [],
      bootstrapAgent: { modelOptions: { auth: "none", maxTokens: 2048 } },
    })
  })
})

it("shows translated bootstrap budget validation before saving", async () => {
  listMock.mockResolvedValue([
    {
      id: "env-bootstrap",
      projectId: "project-1",
      name: "Bootstrap",
      isEnabled: true,
      setupScript: { default: "" },
      actions: [],
      variables: {},
      keyringReferences: [{ variable: "COGNIA_BOOTSTRAP_API_KEY", keyringRef: "provider:key" }],
      bootstrapAgent: {
        enabled: true,
        task: "Prepare",
        baseUrl: "https://api.example.com/v1",
        model: "model",
        checks: [{ name: "ready", command: "true" }],
      },
      createdAt: 1,
      updatedAt: 1,
    },
  ])
  render(<ProjectEnvironmentManager projectId="project-1" executionRoot="/repo" scope="local" />)
  await screen.findByLabelText("Initialization task")
  fireEvent.change(screen.getByLabelText("Maximum steps"), { target: { value: "0" } })
  fireEvent.click(screen.getByRole("button", { name: "Save environment" }))
  expect(await screen.findByText(/Use whole numbers: 1–256 steps/)).toBeInTheDocument()
  expect(putMock).not.toHaveBeenCalled()
})
