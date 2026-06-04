import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Button } from "@/components/ui/button"

const pickMock = jest.fn(async (..._a: unknown[]) => [] as Array<{ content?: string }>)
const detectMock = jest.fn((..._a: unknown[]) => true)
const getDomainMock = jest.fn((..._a: unknown[]) => ({ defaultStrategy: "skip" }))
const applyMock = jest.fn(async (..._a: unknown[]) => ({
  added: {},
  overwritten: {},
  skipped: {},
}))

jest.mock("@/lib/files/file-bridge", () => ({
  pickAndReadFiles: (...a: unknown[]) => pickMock(...a),
}))
// Mocked wholesale: the real module pulls in Dexie via getDb(), which this
// dialog never needs at unit level.
jest.mock("@/lib/data/domain", () => ({
  detectDomainFile: (...a: unknown[]) => detectMock(...a),
  getDomain: (...a: unknown[]) => getDomainMock(...a),
  applyDomainImport: (...a: unknown[]) => applyMock(...a),
}))
jest.mock("./import-summary", () => ({
  ImportSummary: () => <div data-testid="summary">summary</div>,
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))
// Silence the expected-failure log lines in test output.
jest.mock("@/lib/logging", () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }),
}))

import { DomainImportDialog } from "./domain-import-dialog"
import { toast } from "sonner"

const VALID_FILE = {
  version: 3,
  domain: "skills",
  exportedAt: "2026-06-01T00:00:00.000Z",
  appVersion: "0.1.0",
  payload: {},
}

function setup() {
  render(
    <DomainImportDialog
      domain={"skills" as never}
      labelKey="skills"
      trigger={<Button>Open</Button>}
    />
  )
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open" }))
  expect(await screen.findByText("Import skills")).toBeInTheDocument()
}

beforeEach(() => {
  jest.clearAllMocks()
  pickMock.mockResolvedValue([{ content: JSON.stringify(VALID_FILE) }])
  detectMock.mockReturnValue(true)
  getDomainMock.mockReturnValue({ defaultStrategy: "skip" })
  applyMock.mockResolvedValue({ added: {}, overwritten: {}, skipped: {} })
})

describe("DomainImportDialog", () => {
  it("picks a valid file and applies it with the domain's default strategy", async () => {
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    expect(await screen.findByText(/Loaded skills \(exported /)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith(VALID_FILE, "skip"))
    expect(await screen.findByTestId("summary")).toBeInTheDocument()
    expect(toast.success).toHaveBeenCalledWith("Import applied.")

    // The footer Done button shares the "Close" name with the dialog's X
    // affordance; the X carries an icon, the footer button is text-only.
    const done = screen
      .getAllByRole("button", { name: "Close" })
      .find((b) => !b.querySelector("svg"))
    expect(done).toBeDefined()
    await user.click(done!)
    await waitFor(() => expect(screen.queryByText("Import skills")).not.toBeInTheDocument())
  })

  it("applies with the strategy chosen in the select", async () => {
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    fireEvent.click(screen.getByRole("combobox"))
    fireEvent.click(within(screen.getByRole("listbox")).getByText("Overwrite the local row"))

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await screen.findByText(/Loaded skills/)
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith(VALID_FILE, "overwrite"))
  })

  it("rejects a file that is not a domain export", async () => {
    detectMock.mockReturnValue(false)
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Not a Cognia domain file."))
    // No pending file — the picker stays available, Apply never appears.
    expect(screen.getByRole("button", { name: "Choose file…" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument()
  })

  it("rejects a file exported for another domain", async () => {
    pickMock.mockResolvedValue([{ content: JSON.stringify({ ...VALID_FILE, domain: "teams" }) }])
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("File is for teams, not skills."))
    expect(applyMock).not.toHaveBeenCalled()
  })

  it("stays on the picker when the user cancels the file dialog", async () => {
    pickMock.mockResolvedValue([])
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await waitFor(() => expect(pickMock).toHaveBeenCalled())
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Choose file…" })).toBeInTheDocument()
  })

  it("falls back to the skip strategy when the domain spec is unknown", async () => {
    getDomainMock.mockReturnValue(undefined as never)
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await screen.findByText(/Loaded skills/)
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(applyMock).toHaveBeenCalledWith(VALID_FILE, "skip"))
  })

  it("stringifies non-Error picker rejections", async () => {
    pickMock.mockRejectedValueOnce("picker string failure")
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("picker string failure"))
  })

  it("surfaces a picker failure as a toast", async () => {
    pickMock.mockRejectedValueOnce(new Error("picker crashed"))
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("picker crashed"))
    expect(screen.getByRole("button", { name: "Choose file…" })).toBeInTheDocument()
  })

  it("stringifies non-Error apply rejections", async () => {
    applyMock.mockRejectedValueOnce("plain string failure")
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await screen.findByText(/Loaded skills/)
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("plain string failure"))
  })

  it("surfaces an apply failure as a toast", async () => {
    applyMock.mockRejectedValueOnce(new Error("boom"))
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await screen.findByText(/Loaded skills/)
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"))
    expect(screen.queryByTestId("summary")).not.toBeInTheDocument()
  })

  it("resets pending state when the dialog is reopened", async () => {
    const user = userEvent.setup()
    setup()
    await openDialog(user)

    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    await screen.findByText(/Loaded skills/)

    // Both the footer button and the dialog's X are exposed as "Close";
    // either path goes through onOpenChange(false) → reset().
    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!)
    await waitFor(() => expect(screen.queryByText("Import skills")).not.toBeInTheDocument())

    await openDialog(user)
    expect(screen.getByRole("button", { name: "Choose file…" })).toBeInTheDocument()
    expect(screen.queryByText(/Loaded skills/)).not.toBeInTheDocument()
  })
})
