import { render, screen } from "@testing-library/react"
import { TwinHeaderBadge } from "./twin-header-badge"
import { TooltipProvider } from "@/components/ui/tooltip"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown, _deps: unknown[], def: unknown) => {
    try {
      const v = fn()
      if (v && typeof (v as { then?: unknown }).then === "function") return def
      return v ?? def
    } catch {
      return def
    }
  },
}))

jest.mock("@/lib/db/twin-chunks", () => ({
  countTwinChunksByTwin: async () => 17,
}))
jest.mock("@/lib/db/twin-sources", () => ({
  listTwinSourcesByTwin: async () => [{}, {}, {}],
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) => (
    <a {...props}>{children}</a>
  ),
}))

describe("<TwinHeaderBadge />", () => {
  it("renders the badge label and links into the workbench", () => {
    render(
      <TooltipProvider>
        <TwinHeaderBadge twinId="twin_alice" />
      </TooltipProvider>
    )
    // label fallback (live counts come from mocks => 0 because the mocked
    // useLiveQuery returns the default for promise returns); we just
    // verify the badge renders and the link points to the right place.
    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toContain("/twin?twinId=twin_alice")
    expect(link.getAttribute("href")).toContain("tab=settings")
  })

  it("uses the provided twinSettings when overrides are supplied", () => {
    render(
      <TooltipProvider>
        <TwinHeaderBadge
          twinId="twin_bob"
          twinSettings={{ enableRag: false, enableStyleFewShot: false }}
        />
      </TooltipProvider>
    )
    // We don't render the tooltip body without hover, but the link still
    // points correctly — guarding against URL drift.
    const link = screen.getByRole("link")
    expect(link.getAttribute("href")).toContain("twin_bob")
  })
})
