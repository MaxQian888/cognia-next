/** @jest-environment jsdom */

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))

const mockCreate = jest.fn()
const mockListTakenKeys = jest.fn()
jest.mock("@/lib/db/issue-projects", () => ({
  createIssueProject: (...a: unknown[]) => mockCreate(...a),
  listTakenProjectKeys: (...a: unknown[]) => mockListTakenKeys(...a),
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

import userEvent from "@testing-library/user-event"
import { render, screen, waitFor } from "@testing-library/react"
import { CreateProjectDialog } from "./create-project-dialog"

function renderDialog(over: Partial<React.ComponentProps<typeof CreateProjectDialog>> = {}) {
  const props: React.ComponentProps<typeof CreateProjectDialog> = {
    open: true,
    onOpenChange: jest.fn(),
    projectId: "w1",
    ...over,
  }
  return { props, ...render(<CreateProjectDialog {...props} />) }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockListTakenKeys.mockResolvedValue(new Set())
  mockCreate.mockResolvedValue({ id: "p9", key: "MERC", name: "Mercury" })
})

describe("CreateProjectDialog", () => {
  it("renders nothing while shut", () => {
    renderDialog({ open: false })
    expect(screen.queryByTestId("create-project-dialog")).not.toBeInTheDocument()
  })

  it("cannot submit without a name", async () => {
    renderDialog()
    await waitFor(() => expect(mockListTakenKeys).toHaveBeenCalled())
    expect(screen.getByTestId("create-project-submit")).toBeDisabled()
  })

  it("creates with the derived key", async () => {
    const user = userEvent.setup()
    renderDialog()
    await waitFor(() => expect(mockListTakenKeys).toHaveBeenCalled())
    await user.type(screen.getByTestId("create-project-name"), "Mercury")
    await user.click(screen.getByTestId("create-project-submit"))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "w1", name: "Mercury" })
      )
    )
    expect((mockCreate.mock.calls[0][0] as { key: string }).key.length).toBeGreaterThan(0)
  })

  it("carries the description, which is what agents read as context", async () => {
    const user = userEvent.setup()
    renderDialog()
    await waitFor(() => expect(mockListTakenKeys).toHaveBeenCalled())
    await user.type(screen.getByTestId("create-project-name"), "Mercury")
    await user.type(screen.getByTestId("create-project-description"), "Ship the thing")
    await user.click(screen.getByTestId("create-project-submit"))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Ship the thing" })
      )
    )
  })

  it("omits a blank description rather than storing an empty string", async () => {
    const user = userEvent.setup()
    renderDialog()
    await waitFor(() => expect(mockListTakenKeys).toHaveBeenCalled())
    await user.type(screen.getByTestId("create-project-name"), "Mercury")
    await user.click(screen.getByTestId("create-project-submit"))
    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    expect(mockCreate.mock.calls[0][0]).not.toHaveProperty("description")
  })

  it("hands the new container back so the caller can select it", async () => {
    const user = userEvent.setup()
    const onCreated = jest.fn()
    renderDialog({ onCreated })
    await waitFor(() => expect(mockListTakenKeys).toHaveBeenCalled())
    await user.type(screen.getByTestId("create-project-name"), "Mercury")
    await user.click(screen.getByTestId("create-project-submit"))
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({ id: "p9", key: "MERC", name: "Mercury" })
    )
  })

  it("closes on success", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    renderDialog({ onOpenChange })
    await waitFor(() => expect(mockListTakenKeys).toHaveBeenCalled())
    await user.type(screen.getByTestId("create-project-name"), "Mercury")
    await user.click(screen.getByTestId("create-project-submit"))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("stays open and reports a failed write, rather than losing the form", async () => {
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    mockCreate.mockRejectedValueOnce(new Error("key taken"))
    renderDialog({ onOpenChange })
    await waitFor(() => expect(mockListTakenKeys).toHaveBeenCalled())
    await user.type(screen.getByTestId("create-project-name"), "Mercury")
    await user.click(screen.getByTestId("create-project-submit"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("key taken"))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId("create-project-name")).toHaveValue("Mercury")
  })

  it("refuses a key that is already taken", async () => {
    const user = userEvent.setup()
    mockListTakenKeys.mockResolvedValue(new Set(["MINE"]))
    renderDialog()
    await waitFor(() => expect(mockListTakenKeys).toHaveBeenCalled())
    await user.type(screen.getByTestId("create-project-name"), "Mercury")
    await user.clear(screen.getByTestId("create-project-key"))
    await user.type(screen.getByTestId("create-project-key"), "MINE")
    expect(screen.getByTestId("create-project-submit")).toBeDisabled()
    expect(screen.getByText("projects.keyTaken")).toBeInTheDocument()
  })
})
