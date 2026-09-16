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
