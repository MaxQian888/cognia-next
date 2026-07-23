import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const buildExportMock = jest.fn(async (..._a: unknown[]) => ({ version: 3 }))
const serializeMock = jest.fn((..._a: unknown[]) => '{"serialized":true}')
const fileNameMock = jest.fn((..._a: unknown[]) => "cognia-skills-2026-06-04.json")
const saveMock = jest.fn(async (..._a: unknown[]) => null as string | null)
const writeTextFileMock = jest.fn(async (..._a: unknown[]) => undefined)

// Mocked wholesale: the real module pulls in Dexie via getDb(). Two specs are
// enough to prove the tab renders one row per DOMAIN_TRANSFERS entry.
jest.mock("@/lib/data/domain", () => ({
  // The tab renders `getAllDomainTransfers()` (static builtins + the §A-5
  // plugin overlay), not the static array — a plugin-registered spec has to be
  // able to reach the list. The third row stands in for one.
  getAllDomainTransfers: () => [
    { key: "skills", labelKey: "skills" },
    { key: "teams", labelKey: "teams" },
    { key: "pluginDomain", labelKey: "pluginDomain", displayName: "Acme Notes" },
  ],
  buildDomainExport: (...a: unknown[]) => buildExportMock(...a),
  serializeDomainFile: (...a: unknown[]) => serializeMock(...a),
  defaultDomainFileName: (...a: unknown[]) => fileNameMock(...a),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))
// Only meaningful inside Tauri; stubbed so the dynamic imports resolve under
// jsdom when the isTauri() branch is exercised.
jest.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...a: unknown[]) => saveMock(...a),
}))
jest.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...a: unknown[]) => writeTextFileMock(...a),
}))
// The dialogs have their own suites — here they reduce to their triggers.
jest.mock("@/components/data/import/chat-import-dialog", () => ({
  ChatImportDialog: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}))
jest.mock("@/components/data/import/domain-import-dialog", () => ({
  DomainImportDialog: ({ trigger }: { trigger: React.ReactNode }) => <>{trigger}</>,
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { DomainTransferTab } from "./domain-transfer-tab"
import { toast } from "sonner"

const isTauriMock = (jest.requireMock("@/lib/tauri") as { isTauri: jest.Mock }).isTauri

function skillsRow() {
  const row = screen.getByText("Skills").closest("li")
  if (!row) throw new Error("skills row not rendered")
  return within(row)
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(false)
  buildExportMock.mockResolvedValue({ version: 3 })
  serializeMock.mockReturnValue('{"serialized":true}')
  fileNameMock.mockReturnValue("cognia-skills-2026-06-04.json")
})

describe("DomainTransferTab", () => {
  it("renders the external platform cards and one row per domain", () => {
    render(<DomainTransferTab />)

    expect(screen.getByText("ChatGPT")).toBeInTheDocument()
    expect(screen.getByText("Claude.ai")).toBeInTheDocument()
    expect(screen.getByText("Gemini / Bard")).toBeInTheDocument()

    expect(screen.getByText("Skills")).toBeInTheDocument()
    expect(screen.getByText("Reusable instruction blobs.")).toBeInTheDocument()
    expect(screen.getByText("Teams")).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: "Export" })).toHaveLength(3)
    expect(screen.getAllByRole("button", { name: "Import" })).toHaveLength(3)
  })

  it("labels a plugin-contributed domain by its displayName, not a raw key", () => {
    render(<DomainTransferTab />)

    // A plugin has no entry in the message catalog, so translating its
    // labelKey would print `domain.pluginDomain.title` on screen.
    expect(screen.getByText("Acme Notes")).toBeInTheDocument()
    expect(screen.queryByText(/domain\.pluginDomain/)).not.toBeInTheDocument()
  })

  it("exports via a blob download in the browser", async () => {
    const createObjectURL = jest.fn(() => "blob:cognia")
    const revokeObjectURL = jest.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})

    const user = userEvent.setup()
    render(<DomainTransferTab />)
    await user.click(skillsRow().getByRole("button", { name: "Export" }))

    await waitFor(() => expect(click).toHaveBeenCalled())
    expect(buildExportMock).toHaveBeenCalledWith("skills")
    expect(serializeMock).toHaveBeenCalledWith({ version: 3 })
    expect(createObjectURL).toHaveBeenCalled()
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:cognia")
    click.mockRestore()
  })

  it("exports through the save dialog in Tauri", async () => {
    isTauriMock.mockReturnValue(true)
    saveMock.mockResolvedValueOnce("C:/exports/skills.json")

    const user = userEvent.setup()
    render(<DomainTransferTab />)
    await user.click(skillsRow().getByRole("button", { name: "Export" }))

    await waitFor(() =>
      expect(writeTextFileMock).toHaveBeenCalledWith(
        "C:/exports/skills.json",
        '{"serialized":true}'
      )
    )
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "cognia-skills-2026-06-04.json" })
    )
    expect(toast.success).toHaveBeenCalledWith("Export saved.")
  })

  it("writes nothing when the Tauri save dialog is cancelled", async () => {
    isTauriMock.mockReturnValue(true)
    saveMock.mockResolvedValueOnce(null)

    const user = userEvent.setup()
    render(<DomainTransferTab />)
    await user.click(skillsRow().getByRole("button", { name: "Export" }))

    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(writeTextFileMock).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("surfaces an export failure as a toast", async () => {
    buildExportMock.mockRejectedValueOnce(new Error("dexie exploded"))

    const user = userEvent.setup()
    render(<DomainTransferTab />)
    await user.click(skillsRow().getByRole("button", { name: "Export" }))

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("dexie exploded"))
  })
})
