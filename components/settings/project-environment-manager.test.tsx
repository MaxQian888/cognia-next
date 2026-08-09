import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const listMock = jest.fn()
const putMock = jest.fn()
const deleteMock = jest.fn()
jest.mock("@/lib/db/project-environments", () => ({
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

import { ProjectEnvironmentManager } from "./project-environment-manager"

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([])
  putMock.mockReset().mockResolvedValue(undefined)
  deleteMock.mockReset().mockResolvedValue(undefined)
  executeMock.mockReset().mockResolvedValue({ success: true, bypassed: false })
  updateProjectMock.mockReset()
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
