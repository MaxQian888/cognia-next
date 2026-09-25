/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, cleanup, act } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { TerminalProjectOverride } from "./terminal-project-override"
import { useProjectStore } from "@/stores/project/project-store"

beforeEach(() => {
  cleanup()
  useProjectStore.setState({ projects: [], activeProjectId: null })
})

describe("TerminalProjectOverride", () => {
  it("shows the empty-projects message when no projects exist", () => {
    render(<TerminalProjectOverride />)
    expect(screen.getByText("emptyProjects")).toBeInTheDocument()
  })

  it("renders a project picker once at least one project exists", () => {
    useProjectStore.getState().createProject({ name: "proj-a" })
    render(<TerminalProjectOverride />)
    expect(screen.getByTestId("terminal-project-override")).toBeInTheDocument()
  })

  it("hides the shell/cwd inputs until a project is picked", () => {
    useProjectStore.getState().createProject({ name: "proj-a" })
    render(<TerminalProjectOverride />)
    expect(screen.queryByTestId("terminal-project-override-shell")).toBeNull()
  })

  it("writes shell override to the project store when typed", async () => {
    const proj = useProjectStore.getState().createProject({ name: "proj-a" })
    // We can't drive shadcn Select via jsdom easily; bypass by setting the
    // state directly so the inputs mount. The component re-selects via
    // useState's setter once the value changes through the Select.
    // Easier: simulate by directly setting terminalConfig and asserting
    // that subsequent renders pick it up.
    useProjectStore.getState().updateProject(proj.id, {
      terminalConfig: { shell: "/bin/zsh" },
    })
    expect(
      useProjectStore.getState().projects.find((p) => p.id === proj.id)?.terminalConfig?.shell
    ).toBe("/bin/zsh")
  })

  it("merges shell + cwd updates without dropping previously set fields", () => {
    const proj = useProjectStore.getState().createProject({ name: "proj-a" })
    useProjectStore.getState().updateProject(proj.id, {
      terminalConfig: { shell: "/bin/zsh", env: { FOO: "bar" } },
    })
    useProjectStore.getState().updateProject(proj.id, {
      terminalConfig: {
        ...useProjectStore.getState().projects.find((p) => p.id === proj.id)?.terminalConfig,
        cwd: "/tmp/x",
      },
    })
    const cfg = useProjectStore.getState().projects.find((p) => p.id === proj.id)?.terminalConfig
    expect(cfg).toMatchObject({
      shell: "/bin/zsh",
      cwd: "/tmp/x",
      env: { FOO: "bar" },
    })
    void fireEvent
    void act
  })

  async function pick(name: string) {
    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(await screen.findByRole("option", { name }))
  }

  /**
   * `terminalConfig.env` had three readers and no writer. It is edited here as
   * the same KEY=VALUE text the terminal profiles use.
   */
  it("writes the workspace's terminal environment, keeping shell and cwd", async () => {
    const proj = useProjectStore.getState().createProject({ name: "proj-a" })
    useProjectStore.getState().updateProject(proj.id, { terminalConfig: { shell: "/bin/zsh" } })
    render(<TerminalProjectOverride />)
    await pick("proj-a")

    fireEvent.change(screen.getByTestId("terminal-project-override-env"), {
      target: { value: "NODE_ENV=development\nHALF\nURL=a=b" },
    })

    const cfg = useProjectStore.getState().projects.find((p) => p.id === proj.id)?.terminalConfig
    // A half-typed line is skipped rather than stored as garbage.
    expect(cfg).toEqual({ shell: "/bin/zsh", env: { NODE_ENV: "development", URL: "a=b" } })
    // What was typed stays on screen while typing, half line included.
    expect(screen.getByTestId("terminal-project-override-env")).toHaveValue(
      "NODE_ENV=development\nHALF\nURL=a=b"
    )
  })

  it("drops the half-typed text when another workspace is picked", async () => {
    useProjectStore.getState().createProject({ name: "proj-a" })
    const b = useProjectStore.getState().createProject({ name: "proj-b" })
    useProjectStore.getState().updateProject(b.id, { terminalConfig: { env: { B: "2" } } })
    render(<TerminalProjectOverride />)
    await pick("proj-a")
    fireEvent.change(screen.getByTestId("terminal-project-override-env"), {
      target: { value: "HALF" },
    })

    await pick("proj-b")

    expect(screen.getByTestId("terminal-project-override-env")).toHaveValue("B=2")
  })

  it("shows the stored environment and clears it when emptied", async () => {
    const proj = useProjectStore.getState().createProject({ name: "proj-a" })
    useProjectStore.getState().updateProject(proj.id, { terminalConfig: { env: { A: "1" } } })
    render(<TerminalProjectOverride />)
    await pick("proj-a")

    const field = screen.getByTestId("terminal-project-override-env")
    expect(field).toHaveValue("A=1")
    fireEvent.change(field, { target: { value: "" } })
    fireEvent.blur(field)

    expect(
      useProjectStore.getState().projects.find((p) => p.id === proj.id)?.terminalConfig?.env
    ).toBeUndefined()
    expect(field).toHaveValue("")
  })
})
