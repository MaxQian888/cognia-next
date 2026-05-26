import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"
import { SingleExportDialog } from "./single-export-dialog"
import type { ChatSession } from "@/lib/claude/types"

jest.mock("@/hooks/data/use-single-export", () => ({
  useSingleExport: () => ({ run: jest.fn(), busy: false }),
}))
jest.mock("@/stores/theme", () => ({
  useCustomThemeStore: () => undefined,
}))

const session = { id: "s1", title: "My chat" } as ChatSession

describe("SingleExportDialog", () => {
  it("renders the format picker and a share-via-link action", () => {
    render(<SingleExportDialog session={session} open onOpenChange={() => {}} />)
    expect(screen.getByText("Share via link")).toBeInTheDocument()
  })
})
