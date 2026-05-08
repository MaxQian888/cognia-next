import { fireEvent, render, screen } from "@testing-library/react"
import { RelatedSectionsStrip, CLAUDE_CODE_RELATED } from "./related-sections-strip"

const replaceMock = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams("section=agent-runtime"),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
}))

beforeEach(() => {
  replaceMock.mockClear()
})

describe("RelatedSectionsStrip", () => {
  it("renders one pill per non-current target", () => {
    render(<RelatedSectionsStrip current="agent-runtime" targets={CLAUDE_CODE_RELATED} />)
    // Both agent-runtime targets (defaults + sessions) should be hidden when
    // the current section is agent-runtime, but the link strip should drop
    // them — actually, only when the section matches. The two agent-runtime
    // entries with different tab params both match `current=agent-runtime`.
    expect(screen.queryByTestId("related-link-agent-runtime-defaults")).toBeNull()
    expect(screen.queryByTestId("related-link-agent-runtime-sessions")).toBeNull()
    // Other sections appear.
    expect(screen.getByTestId("related-link-mcp")).toBeInTheDocument()
    expect(screen.getByTestId("related-link-hooks")).toBeInTheDocument()
  })

  it("returns null when every target is the current section", () => {
    const { container } = render(
      <RelatedSectionsStrip current="mcp" targets={[{ section: "mcp", labelKey: "mcp" }]} />
    )
    expect(container.firstChild).toBeNull()
  })

  it("clicking a pill calls router.replace with the target's params", () => {
    render(<RelatedSectionsStrip current="agent-runtime" targets={CLAUDE_CODE_RELATED} />)
    fireEvent.click(screen.getByTestId("related-link-mcp"))
    expect(replaceMock).toHaveBeenCalledWith("?section=mcp", { scroll: false })
  })

  it("includes the tab param when target carries one", () => {
    render(
      <RelatedSectionsStrip
        current="hooks"
        targets={[
          {
            section: "agent-runtime",
            tabParam: "agentRuntimeTab",
            tab: "sessions",
            labelKey: "sessions",
          },
        ]}
      />
    )
    fireEvent.click(screen.getByTestId("related-link-agent-runtime-sessions"))
    expect(replaceMock).toHaveBeenCalledWith(expect.stringContaining("section=agent-runtime"), {
      scroll: false,
    })
    expect(replaceMock.mock.calls[0][0]).toContain("agentRuntimeTab=sessions")
  })

  it("omits an undefined tabParam (only tabParam needs both pieces)", () => {
    render(<RelatedSectionsStrip current="hooks" targets={[{ section: "mcp", labelKey: "mcp" }]} />)
    fireEvent.click(screen.getByTestId("related-link-mcp"))
    expect(replaceMock).toHaveBeenCalledWith("?section=mcp", { scroll: false })
  })
})
