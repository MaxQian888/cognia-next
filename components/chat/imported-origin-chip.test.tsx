import { fireEvent, render as rtlRender, screen } from "@testing-library/react"

import { TooltipProvider } from "@/components/ui/tooltip"

import type { ChatSession } from "@cognia/agent-config-types"

const acknowledge = jest.fn(async (_id: string) => {})
jest.mock("@/lib/db/sessions", () => ({
  acknowledgeImportDivergence: (id: string) => acknowledge(id),
}))
jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, vals?: Record<string, unknown>) =>
    vals ? `${ns}.${key}:${JSON.stringify(vals)}` : `${ns}.${key}`,
}))

import { ImportedOriginChip } from "./imported-origin-chip"

// `TooltipProvider` is mounted app-wide in `app/layout.tsx`; supply it here.
const render = (ui: React.ReactElement) => rtlRender(<TooltipProvider>{ui}</TooltipProvider>)

function session(over: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "import:claude-code:abc",
    title: "Fix the parser",
    createdAt: 0,
    updatedAt: 0,
    importSource: "claude-code",
    importSourceLabel: "Claude Code",
    ...over,
  } as ChatSession
}

beforeEach(() => acknowledge.mockClear())

describe("ImportedOriginChip", () => {
  it("renders nothing for a native session", () => {
    const { container } = render(
      <ImportedOriginChip
        session={{ id: "s1", title: "x", createdAt: 0, updatedAt: 0 } as ChatSession}
      />
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("names a built-in source from the message catalogue, not the stored label", () => {
    render(<ImportedOriginChip session={session()} />)
    // The catalogue entry is what makes the label localized.
    expect(screen.getByTestId("imported-origin-chip")).toHaveTextContent(
      "sessionImport.sources.claude-code"
    )
  })

  it("uses the stamped label for a plugin source instead of a raw key path", () => {
    render(
      <ImportedOriginChip
        session={session({
          id: "import:acme:cursor:1",
          importSource: "acme:cursor",
          importSourceLabel: "Cursor (Acme)",
        })}
      />
    )
    expect(screen.getByTestId("imported-origin-chip")).toHaveTextContent("Cursor (Acme)")
  })

  it("still identifies a row imported before importSource existed", () => {
    render(
      <ImportedOriginChip
        session={session({ importSource: undefined, importSourceLabel: undefined })}
      />
    )
    expect(screen.getByTestId("imported-origin-chip")).toHaveTextContent("unknownSource")
  })

  it("warns when the source diverged after Cognia took ownership", () => {
    render(<ImportedOriginChip session={session({ importFrozen: true, importDiverged: true })} />)
    expect(screen.getByTestId("imported-diverged-chip")).toBeInTheDocument()
    expect(screen.queryByTestId("imported-origin-chip")).not.toBeInTheDocument()
  })

  it("acknowledging the divergence clears it", () => {
    render(<ImportedOriginChip session={session({ importDiverged: true })} />)
    fireEvent.click(screen.getByTestId("imported-diverged-chip"))
    expect(acknowledge).toHaveBeenCalledWith("import:claude-code:abc")
  })
})
