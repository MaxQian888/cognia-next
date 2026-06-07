/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations:
    (_ns: string) =>
    (key: string): string =>
      key,
}))

import { LspEditDialog } from "./add-lsp-dialog"
import type { LspServerConfig } from "@/types/lsp/config"

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

describe("LspEditDialog", () => {
  it("renders nothing when `open=false`", () => {
    render(<LspEditDialog open={false} onOpenChange={() => {}} onSubmit={() => {}} />)
    expect(screen.queryByTestId("add-lsp-dialog")).not.toBeInTheDocument()
  })

  it("renders the full field set when open", () => {
    render(<LspEditDialog open onOpenChange={() => {}} onSubmit={() => {}} />)
    for (const f of [
      "field.name",
      "field.languages",
      "field.extensions",
      "field.command",
      "field.args",
      "field.env",
      "field.rootMarkers",
      "field.settings",
    ]) {
      expect(screen.getByLabelText(f)).toBeInTheDocument()
    }
  })

  it("validates name, command, languages in order", () => {
    const onSubmit = jest.fn()
    render(<LspEditDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.name")

    fill("field.name", "ESLint")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.command")

    fill("field.command", "/x")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.languages")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("parses every field and generates an id in add mode", () => {
    const onSubmit = jest.fn()
    render(<LspEditDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)
    fill("field.name", "ESLint")
    fill("field.languages", "typescript, javascript")
    fill("field.extensions", "ts, TSX")
    fill("field.command", "/x")
    fill("field.args", "--stdio\n--debug")
    fill("field.env", "NODE_ENV=production\nDEBUG=1")
    fill("field.rootMarkers", ".eslintrc, package.json")
    fill("field.settings", '{"eslint":{"run":"onSave"}}')
    fireEvent.click(screen.getByRole("button", { name: "submit" }))

    const arg = onSubmit.mock.calls[0][0] as LspServerConfig
    expect(arg.id).toMatch(/^lsp_/)
    expect(arg.languages).toEqual(["typescript", "javascript"])
    expect(arg.extensions).toEqual([".ts", ".tsx"]) // normalised with leading dot, lower-cased
    expect(arg.args).toEqual(["--stdio", "--debug"])
    expect(arg.env).toEqual({ NODE_ENV: "production", DEBUG: "1" })
    expect(arg.rootMarkers).toEqual([".eslintrc", "package.json"])
    expect(arg.settings).toEqual({ eslint: { run: "onSave" } })
    expect(arg.transport).toBe("stdio")
  })

  it("rejects invalid settings JSON", () => {
    const onSubmit = jest.fn()
    render(<LspEditDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)
    fill("field.name", "x")
    fill("field.languages", "ts")
    fill("field.command", "/x")
    fill("field.settings", "{ not json")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.settings")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("rejects a JSON array for settings (must be an object)", () => {
    const onSubmit = jest.fn()
    render(<LspEditDialog open onOpenChange={() => {}} onSubmit={onSubmit} />)
    fill("field.name", "x")
    fill("field.languages", "ts")
    fill("field.command", "/x")
    fill("field.settings", "[1,2,3]")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.settings")
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it("prefills and pins the id in edit mode, and saves", () => {
    const onSubmit = jest.fn()
    const initial: LspServerConfig = {
      id: "rust-analyzer",
      name: "rust-analyzer",
      languages: ["rust"],
      command: "rust-analyzer",
      settings: { "rust-analyzer": { cargo: { features: "all" } } },
    }
    render(<LspEditDialog open onOpenChange={() => {}} initial={initial} onSubmit={onSubmit} />)
    expect((screen.getByLabelText("field.name") as HTMLInputElement).value).toBe("rust-analyzer")
    fill("field.command", "/opt/ra")
    fireEvent.click(screen.getByRole("button", { name: "save" }))
    const arg = onSubmit.mock.calls[0][0] as LspServerConfig
    expect(arg.id).toBe("rust-analyzer") // id pinned
    expect(arg.command).toBe("/opt/ra")
    expect(arg.settings).toEqual({ "rust-analyzer": { cargo: { features: "all" } } })
  })

  it("rejects a duplicate id in add mode", () => {
    const onSubmit = jest.fn()
    // Force a generated id collision by stubbing crypto.randomUUID.
    const original = (globalThis.crypto as Crypto).randomUUID
    ;(globalThis.crypto as { randomUUID: () => string }).randomUUID = () =>
      "dup00000-0000-0000-0000-000000000000"
    render(
      <LspEditDialog
        open
        onOpenChange={() => {}}
        existingIds={["lsp_dup00000"]}
        onSubmit={onSubmit}
      />
    )
    fill("field.name", "x")
    fill("field.languages", "ts")
    fill("field.command", "/x")
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.duplicate")
    expect(onSubmit).not.toHaveBeenCalled()
    ;(globalThis.crypto as { randomUUID: typeof original }).randomUUID = original
  })

  it("Cancel closes without submitting", () => {
    const onOpenChange = jest.fn()
    const onSubmit = jest.fn()
    render(<LspEditDialog open onOpenChange={onOpenChange} onSubmit={onSubmit} />)
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
