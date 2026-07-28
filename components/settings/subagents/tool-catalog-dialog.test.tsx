/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { ToolCatalogEntry } from "@/lib/tools/tool-catalog"

import { ToolCatalogDialog } from "./tool-catalog-dialog"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
}))

const getToolCatalog = jest.fn()
jest.mock("@/lib/tools/tool-catalog", () => ({
  ...jest.requireActual("@/lib/tools/tool-catalog"),
  getToolCatalog: () => getToolCatalog(),
}))

const entry = (over: Partial<ToolCatalogEntry> & { id: string }): ToolCatalogEntry => ({
  name: over.id,
  source: "builtin",
  description: "",
  enabled: true,
  ...over,
})

const CATALOG: ToolCatalogEntry[] = [
  entry({ id: "Read", riskLevel: "low" }),
  entry({ id: "Bash", riskLevel: "high" }),
  entry({ id: "mcp__acme__query", name: "query", source: "mcp", ownerName: "acme" }),
]

beforeEach(() => {
  getToolCatalog.mockReset()
  getToolCatalog.mockResolvedValue(CATALOG)
})

const noop = () => {}

describe("ToolCatalogDialog", () => {
  it("shows a loading state until the catalog resolves", async () => {
    let resolve: ((v: ToolCatalogEntry[]) => void) | undefined
    getToolCatalog.mockReturnValue(new Promise((r) => (resolve = r)))
    render(<ToolCatalogDialog open onOpenChange={noop} selected={[]} onConfirm={noop} />)
    expect(screen.getByTestId("tool-catalog-loading")).toBeInTheDocument()
    resolve?.(CATALOG)
    await waitFor(() =>
      expect(screen.queryByTestId("tool-catalog-loading")).not.toBeInTheDocument()
    )
  })

  it("groups entries by source", async () => {
    render(<ToolCatalogDialog open onOpenChange={noop} selected={[]} onConfirm={noop} />)
    await screen.findByTestId("tool-catalog-group-builtin")
    expect(screen.getByTestId("tool-catalog-group-mcp")).toBeInTheDocument()
  })

  it("filters by free text over name and owner", async () => {
    render(<ToolCatalogDialog open onOpenChange={noop} selected={[]} onConfirm={noop} />)
    await screen.findByTestId("tool-catalog-row-Read")
    await userEvent.type(screen.getByTestId("tool-catalog-search"), "acme")
    await waitFor(() =>
      expect(screen.queryByTestId("tool-catalog-row-Read")).not.toBeInTheDocument()
    )
    expect(screen.getByTestId("tool-catalog-row-mcp__acme__query")).toBeInTheDocument()
  })

  it("restricts to the requested sources", async () => {
    render(
      <ToolCatalogDialog
        open
        onOpenChange={noop}
        selected={[]}
        onConfirm={noop}
        sources={["mcp"]}
      />
    )
    await screen.findByTestId("tool-catalog-group-mcp")
    expect(screen.queryByTestId("tool-catalog-group-builtin")).not.toBeInTheDocument()
  })

  it("confirms the toggled selection", async () => {
    const onConfirm = jest.fn()
    render(<ToolCatalogDialog open onOpenChange={noop} selected={[]} onConfirm={onConfirm} />)
    await screen.findByTestId("tool-catalog-row-Read")
    await userEvent.click(screen.getByTestId("tool-catalog-row-Read"))
    await userEvent.click(screen.getByTestId("tool-catalog-confirm"))
    expect(onConfirm).toHaveBeenCalledWith(["Read"])
  })

  it("keeps a granted tool the catalog no longer knows, instead of dropping it", async () => {
    const onConfirm = jest.fn()
    render(
      <ToolCatalogDialog
        open
        onOpenChange={noop}
        selected={["mcp__gone__tool"]}
        onConfirm={onConfirm}
      />
    )
    await screen.findByTestId("tool-catalog-group-unknown")
    await userEvent.click(screen.getByTestId("tool-catalog-confirm"))
    expect(onConfirm).toHaveBeenCalledWith(["mcp__gone__tool"])
  })

  it("reports an empty catalog rather than rendering a blank box", async () => {
    getToolCatalog.mockResolvedValue([])
    render(<ToolCatalogDialog open onOpenChange={noop} selected={[]} onConfirm={noop} />)
    expect(await screen.findByTestId("tool-catalog-empty")).toBeInTheDocument()
  })

  it("does not load the catalog while closed", () => {
    render(<ToolCatalogDialog open={false} onOpenChange={noop} selected={[]} onConfirm={noop} />)
    expect(getToolCatalog).not.toHaveBeenCalled()
  })
})
