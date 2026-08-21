import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Button } from "@/components/ui/button"

const flow = {
  state: { status: "idle" } as Record<string, unknown>,
  pickFile: jest.fn(async () => {}),
  applyAll: jest.fn(async () => ({ sessions: 1, messages: 2 })),
  reset: jest.fn(),
}

jest.mock("@/hooks/data/use-chat-import", () => ({ useChatImport: () => flow }))
jest.mock("@/lib/data/import-registry", () => ({
  getImporterLabel: (format: string) => (format === "acme:slack" ? "Slack export" : undefined),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { ChatImportDialog } from "./chat-import-dialog"
import { toast } from "sonner"

function setup() {
  render(<ChatImportDialog trigger={<Button>Open</Button>} />)
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Open" }))
  expect(await screen.findByText("Import conversations")).toBeInTheDocument()
}

beforeEach(() => {
  jest.clearAllMocks()
  flow.state = { status: "idle" }
})

describe("ChatImportDialog", () => {
  it("picks a file from the idle state", async () => {
    const user = userEvent.setup()
    setup()
    await openDialog(user)
    await user.click(screen.getByRole("button", { name: "Choose file…" }))
    expect(flow.pickFile).toHaveBeenCalled()
  })

  it("labels a plugin-contributed format by its declared label", async () => {
    flow.state = {
      status: "preview",
      format: "acme:slack",
      conversations: [{ session: { id: "s1", title: "Thread" }, messages: [{}, {}] }],
    }
    const user = userEvent.setup()
    setup()
    await openDialog(user)
    expect(screen.getByText(/Slack export/)).toBeInTheDocument()
  })

  it("applies and toasts the written counts", async () => {
    flow.state = {
      status: "preview",
      format: "chatgpt",
      conversations: [{ session: { id: "s1", title: "Thread" }, messages: [{}] }],
    }
    const user = userEvent.setup()
    setup()
    await openDialog(user)
    await user.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
  })

  it("names the restore flow when the file is a Cognia backup", async () => {
    // The rejection used to be indistinguishable from a parse failure: the
    // dialog printed the raw error text for every miss.
    flow.state = {
      status: "error",
      message: "Could not import this file as a conversation export (cognia-backup).",
      rejection: "cognia-backup",
    }
    const user = userEvent.setup()
    setup()
    await openDialog(user)
    expect(screen.getByText(/Restore it from Backup & restore/)).toBeInTheDocument()
  })

  it("explains an encrypted backup rather than showing a parse error", async () => {
    flow.state = { status: "error", message: "boom", rejection: "encrypted" }
    const user = userEvent.setup()
    setup()
    await openDialog(user)
    expect(screen.getByText(/This backup is encrypted/)).toBeInTheDocument()
  })

  it("falls back to the raw error text when there is no typed rejection", async () => {
    flow.state = { status: "error", message: "picker exploded" }
    const user = userEvent.setup()
    setup()
    await openDialog(user)
    expect(screen.getByText("picker exploded")).toBeInTheDocument()
  })
})
