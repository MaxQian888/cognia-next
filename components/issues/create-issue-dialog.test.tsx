/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const mockCreateIssue = jest.fn()
const mockCreateIssueProject = jest.fn()
const mockListTakenProjectKeys = jest.fn()
jest.mock("@/lib/db/issues", () => ({ createIssue: (...a: unknown[]) => mockCreateIssue(...a) }))
jest.mock("@/lib/db/issue-projects", () => ({
  createIssueProject: (...a: unknown[]) => mockCreateIssueProject(...a),
  listTakenProjectKeys: (...a: unknown[]) => mockListTakenProjectKeys(...a),
}))
// Own suite; here it only needs to hand an actor back.
let pickerOnChange: ((actor: unknown) => void) | null = null
jest.mock("./assignee-picker", () => ({
  AssigneePicker: (props: { onChange: (actor: unknown) => void }) => {
    pickerOnChange = props.onChange
    return <div data-testid="assignee-picker-stub" />
  },
}))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { CreateIssueDialog } from "./create-issue-dialog"

const PROJECT = {
  id: "p1",
  projectId: "w1",
  key: "MERC",
  name: "Mercury",
  status: "planned" as const,
  priority: "none" as const,
  resources: [],
  createdAt: 1,
  updatedAt: 1,
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof CreateIssueDialog>> = {}) {
  const props: React.ComponentProps<typeof CreateIssueDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    projectId: "w1",
    projects: [PROJECT],
    ...overrides,
  }
  return { ...render(<CreateIssueDialog {...props} />), props }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockListTakenProjectKeys.mockResolvedValue(new Set<string>())
  mockCreateIssue.mockResolvedValue({ id: "iss_1" })
  mockCreateIssueProject.mockResolvedValue({ id: "p-new" })
})

describe("CreateIssueDialog", () => {
  it("offers a project picker when the workspace already has one", async () => {
    renderDialog()
    expect(await screen.findByTestId("create-issue-project")).toBeInTheDocument()
    expect(screen.queryByTestId("create-issue-project-name")).not.toBeInTheDocument()
  })

  it("grows a project field on first run, so an empty board is not a dead end", async () => {
    renderDialog({ projects: [] })
    expect(await screen.findByTestId("create-issue-project-name")).toBeInTheDocument()
    expect(screen.getByText("create.noProject")).toBeInTheDocument()
  })

  it("derives the key from the project name until the user edits it", async () => {
    const user = userEvent.setup()
    renderDialog({ projects: [] })
    await user.type(await screen.findByTestId("create-issue-project-name"), "Cognia")
    await waitFor(() => expect(screen.getByTestId("create-issue-project-key")).toHaveValue("COGN"))
  })

  it("stops deriving once the key is edited by hand", async () => {
    const user = userEvent.setup()
    renderDialog({ projects: [] })
    const key = await screen.findByTestId("create-issue-project-key")
    await user.type(key, "abc")
    await user.type(await screen.findByTestId("create-issue-project-name"), "Cognia")
    expect(key).toHaveValue("ABC")
  })

  it("carries the picked assignee into createIssue", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.type(await screen.findByTestId("create-issue-title"), "Do it")
    pickerOnChange!({ kind: "agent", id: "c1", label: "Ada" })
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({ assignee: { kind: "agent", id: "c1", label: "Ada" } })
      )
    )
  })

  it("blocks submit until a title exists", async () => {
    const user = userEvent.setup()
    renderDialog()
    const submit = await screen.findByTestId("create-issue-submit")
    expect(submit).toBeDisabled()
    await user.type(screen.getByTestId("create-issue-title"), "Ship it")
    expect(submit).toBeEnabled()
  })

  it("creates the issue against the chosen project and closes", async () => {
    const user = userEvent.setup()
    const { props } = renderDialog({ status: "todo" })
    await user.type(await screen.findByTestId("create-issue-title"), "Ship it")
    await user.click(screen.getByTestId("create-issue-submit"))

    await waitFor(() =>
      expect(mockCreateIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "w1",
          issueProjectId: "p1",
          title: "Ship it",
          status: "todo",
          createdBy: { kind: "human" },
        })
      )
    )
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("creates the project first when there is none", async () => {
    const user = userEvent.setup()
    renderDialog({ projects: [] })
    await user.type(await screen.findByTestId("create-issue-project-name"), "Cognia")
    await user.type(screen.getByTestId("create-issue-title"), "Ship it")
    await user.click(screen.getByTestId("create-issue-submit"))

    await waitFor(() => expect(mockCreateIssueProject).toHaveBeenCalled())
    expect(mockCreateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ issueProjectId: "p-new" })
    )
  })

  it("refuses a key that is already taken", async () => {
    const user = userEvent.setup()
    mockListTakenProjectKeys.mockResolvedValue(new Set(["ABC"]))
    renderDialog({ projects: [] })
    await user.type(await screen.findByTestId("create-issue-project-name"), "Cognia")
    // The name already derived a key, so clear it before typing the taken one
    // (the field is maxLength-capped and would otherwise just append).
    await user.clear(screen.getByTestId("create-issue-project-key"))
    await user.type(screen.getByTestId("create-issue-project-key"), "ABC")
    await user.type(screen.getByTestId("create-issue-title"), "Ship it")
    await waitFor(() => expect(screen.getByTestId("create-issue-submit")).toBeDisabled())
    expect(screen.getByText("projects.keyTaken")).toBeInTheDocument()
  })

  it("surfaces a write failure instead of closing silently", async () => {
    const user = userEvent.setup()
    mockCreateIssue.mockRejectedValueOnce(new Error("disk on fire"))
    const { props } = renderDialog()
    await user.type(await screen.findByTestId("create-issue-title"), "Ship it")
    await user.click(screen.getByTestId("create-issue-submit"))

    expect(await screen.findByTestId("create-issue-error")).toHaveTextContent("disk on fire")
    expect(props.onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("reports the new issue id so the caller can select it", async () => {
    const user = userEvent.setup()
    const onCreated = jest.fn()
    renderDialog({ onCreated })
    await user.type(await screen.findByTestId("create-issue-title"), "Ship it")
    await user.click(screen.getByTestId("create-issue-submit"))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("iss_1"))
  })

  /*
   * The branch that fixes "one project per workspace, forever". It used to be
   * `projects.length === 0` and nothing else, so once a workspace had a
   * container this path was permanently unreachable.
   */
  describe("creating a container inline", () => {
    it("offers a new-container row even when containers already exist", async () => {
      const user = userEvent.setup()
      renderDialog({ projects: [PROJECT] })
      await user.click(screen.getByTestId("create-issue-project"))
      expect(await screen.findByTestId("create-issue-project-new")).toBeInTheDocument()
    })

    it("switches to the name+key fields when it is picked", async () => {
      const user = userEvent.setup()
      renderDialog({ projects: [PROJECT] })
      await user.click(screen.getByTestId("create-issue-project"))
      await user.click(await screen.findByTestId("create-issue-project-new"))
      expect(await screen.findByTestId("create-issue-project-name")).toBeInTheDocument()
      expect(screen.queryByTestId("create-issue-project")).not.toBeInTheDocument()
    })

    it("can back out to the existing containers", async () => {
      const user = userEvent.setup()
      renderDialog({ projects: [PROJECT] })
      await user.click(screen.getByTestId("create-issue-project"))
      await user.click(await screen.findByTestId("create-issue-project-new"))
      await user.click(await screen.findByTestId("create-issue-project-cancel-new"))
      expect(await screen.findByTestId("create-issue-project")).toBeInTheDocument()
    })

    it("offers no back-out when there is nothing to go back to", async () => {
      renderDialog({ projects: [] })
      await screen.findByTestId("create-issue-project-name")
      expect(screen.queryByTestId("create-issue-project-cancel-new")).not.toBeInTheDocument()
    })

    it("does not read the taken keys until the branch that needs them is showing", async () => {
      renderDialog({ projects: [PROJECT] })
      await screen.findByTestId("create-issue-project")
      expect(mockListTakenProjectKeys).not.toHaveBeenCalled()
    })
  })
})
