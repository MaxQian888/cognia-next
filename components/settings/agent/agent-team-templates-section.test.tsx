/**
 * AgentTeamTemplatesSection — built-in vs user template UX tests
 *
 * Asserts:
 *   - Both built-in and user templates render in the same grid.
 *   - Built-in cards show the "Built-in" badge.
 *   - Edit / Delete buttons are disabled on built-ins.
 *   - Duplicate (always enabled) calls addTemplate with isBuiltIn=false.
 *   - Use button calls createTeam + addTeammate then routes via router.push
 *     to the static workspace search-param route.
 *   - The new-template editor exists and accepts a Save click.
 */

import React from "react"
import { render, screen, within, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { AgentTeamTemplatesSection } from "./agent-team-templates-section"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

const builtIn: AgentTeamTemplate = {
  id: "parallel-review",
  name: "Parallel Review",
  description: "Built-in template",
  category: "review",
  teammates: [
    { name: "Reviewer A", description: "" },
    { name: "Reviewer B", description: "" },
  ],
  isBuiltIn: true,
}
const userTpl: AgentTeamTemplate = {
  id: "user-1",
  name: "My Custom Team",
  description: "User-created",
  category: "general",
  teammates: [{ name: "Helper", description: "" }],
  isBuiltIn: false,
}

const createTeamMock = jest.fn(() => ({ id: "team-new" }))
const addTeammateMock = jest.fn()
const addTemplateMock = jest.fn()
const updateTemplateMock = jest.fn()
const deleteTemplateMock = jest.fn()

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({
      templates: { [builtIn.id]: builtIn, [userTpl.id]: userTpl },
      createTeam: createTeamMock,
      addTeammate: addTeammateMock,
      addTemplate: addTemplateMock,
      updateTemplate: updateTemplateMock,
      deleteTemplate: deleteTemplateMock,
    }),
}))

const routerPushMock = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
    replace: jest.fn(),
    prefetch: jest.fn(),
    back: jest.fn(),
    pathname: "/",
    query: {},
    asPath: "/",
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))

jest.mock("@/lib/logging", () => ({
  loggers: {
    agent: {
      child: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  },
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

beforeEach(() => {
  createTeamMock.mockClear()
  addTeammateMock.mockClear()
  addTemplateMock.mockClear()
  updateTemplateMock.mockClear()
  deleteTemplateMock.mockClear()
  routerPushMock.mockClear()
})

describe("AgentTeamTemplatesSection", () => {
  it("renders both built-in and user templates", () => {
    render(<AgentTeamTemplatesSection />)
    expect(screen.getByTestId(`agent-team-template-row-${builtIn.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`agent-team-template-row-${userTpl.id}`)).toBeInTheDocument()
  })

  it("shows the Built-in badge only on built-in rows", () => {
    render(<AgentTeamTemplatesSection />)
    const builtRow = screen.getByTestId(`agent-team-template-row-${builtIn.id}`)
    expect(builtRow).toHaveAttribute("data-builtin", "true")
    expect(within(builtRow).getByText("Built-in")).toBeInTheDocument()

    const userRow = screen.getByTestId(`agent-team-template-row-${userTpl.id}`)
    expect(userRow).toHaveAttribute("data-builtin", "false")
    expect(within(userRow).queryByText("Built-in")).not.toBeInTheDocument()
  })

  it("disables Edit and Delete on built-ins, enables them on user rows", () => {
    render(<AgentTeamTemplatesSection />)
    expect(screen.getByTestId(`edit-${builtIn.id}`)).toBeDisabled()
    expect(screen.getByTestId(`delete-${builtIn.id}`)).toBeDisabled()
    expect(screen.getByTestId(`edit-${userTpl.id}`)).not.toBeDisabled()
    expect(screen.getByTestId(`delete-${userTpl.id}`)).not.toBeDisabled()
  })

  it("Duplicate is always enabled and forks to a non-built-in row via addTemplate", async () => {
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection />)
    const dupBtn = screen.getByTestId(`duplicate-${builtIn.id}`)
    expect(dupBtn).not.toBeDisabled()
    await act(async () => {
      await user.click(dupBtn)
    })
    expect(addTemplateMock).toHaveBeenCalledTimes(1)
    const cloned = addTemplateMock.mock.calls[0]![0] as AgentTeamTemplate
    expect(cloned.isBuiltIn).toBe(false)
    expect(cloned.id).not.toBe(builtIn.id)
    expect(cloned.name).toContain("(copy)")
  })

  it("Use button calls createTeam + addTeammate then routes to the workspace", async () => {
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection />)
    const useBtn = screen.getByTestId(`use-${builtIn.id}`)
    await act(async () => {
      await user.click(useBtn)
    })
    expect(createTeamMock).toHaveBeenCalledWith(expect.objectContaining({ name: builtIn.name }))
    // Two teammates in the built-in template → addTeammate called twice.
    expect(addTeammateMock).toHaveBeenCalledTimes(2)
    expect(routerPushMock).toHaveBeenCalledWith("/agent-teams/workspace?teamId=team-new")
  })

  it("New template button opens the editor and Save calls addTemplate", async () => {
    const user = userEvent.setup()
    render(<AgentTeamTemplatesSection />)
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /new template/i }))
    })
    const editor = screen.getByTestId("agent-team-template-editor")
    const nameInput = within(editor).getByTestId("editor-name")
    await act(async () => {
      await user.type(nameInput, "My New Team")
    })
    await act(async () => {
      await user.click(within(editor).getByTestId("editor-submit"))
    })
    expect(addTemplateMock).toHaveBeenCalledTimes(1)
    const created = addTemplateMock.mock.calls[0]![0] as AgentTeamTemplate
    expect(created.name).toBe("My New Team")
    expect(created.isBuiltIn).toBe(false)
  })
})
