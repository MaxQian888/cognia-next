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

import { AddLspDialog } from "./add-lsp-dialog"

describe("AddLspDialog", () => {
  it("renders nothing when `open=false`", () => {
    render(<AddLspDialog open={false} onOpenChange={() => {}} onAdd={() => {}} />)
    expect(screen.queryByTestId("add-lsp-dialog")).not.toBeInTheDocument()
  })

  it("renders the form fields when open", () => {
    render(<AddLspDialog open onOpenChange={() => {}} onAdd={() => {}} />)
    expect(screen.getByLabelText("field.name")).toBeInTheDocument()
    expect(screen.getByLabelText("field.languages")).toBeInTheDocument()
    expect(screen.getByLabelText("field.command")).toBeInTheDocument()
    expect(screen.getByLabelText("field.args")).toBeInTheDocument()
  })

  it("requires a non-empty name", () => {
    const onAdd = jest.fn()
    render(<AddLspDialog open onOpenChange={() => {}} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.name")
    expect(onAdd).not.toHaveBeenCalled()
  })

  it("requires a non-empty command", () => {
    const onAdd = jest.fn()
    render(<AddLspDialog open onOpenChange={() => {}} onAdd={onAdd} />)
    fireEvent.change(screen.getByLabelText("field.name"), { target: { value: "ESLint" } })
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.command")
    expect(onAdd).not.toHaveBeenCalled()
  })

  it("requires at least one language", () => {
    const onAdd = jest.fn()
    render(<AddLspDialog open onOpenChange={() => {}} onAdd={onAdd} />)
    fireEvent.change(screen.getByLabelText("field.name"), { target: { value: "ESLint" } })
    fireEvent.change(screen.getByLabelText("field.command"), { target: { value: "/x" } })
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(screen.getByRole("alert")).toHaveTextContent("error.languages")
    expect(onAdd).not.toHaveBeenCalled()
  })

  it("parses comma-separated languages and newline-split args", () => {
    const onAdd = jest.fn()
    render(<AddLspDialog open onOpenChange={() => {}} onAdd={onAdd} />)
    fireEvent.change(screen.getByLabelText("field.name"), { target: { value: "ESLint" } })
    fireEvent.change(screen.getByLabelText("field.languages"), {
      target: { value: "typescript, javascript" },
    })
    fireEvent.change(screen.getByLabelText("field.command"), { target: { value: "/x" } })
    fireEvent.change(screen.getByLabelText("field.args"), { target: { value: "--stdio\n--debug" } })
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    expect(onAdd).toHaveBeenCalledWith({
      name: "ESLint",
      languages: ["typescript", "javascript"],
      command: "/x",
      args: ["--stdio", "--debug"],
      transport: "stdio",
      enabled: true,
    })
  })

  it("omits args when the field is empty", () => {
    const onAdd = jest.fn()
    render(<AddLspDialog open onOpenChange={() => {}} onAdd={onAdd} />)
    fireEvent.change(screen.getByLabelText("field.name"), { target: { value: "x" } })
    fireEvent.change(screen.getByLabelText("field.languages"), { target: { value: "ts" } })
    fireEvent.change(screen.getByLabelText("field.command"), { target: { value: "/x" } })
    fireEvent.click(screen.getByRole("button", { name: "submit" }))
    const arg = onAdd.mock.calls[0][0]
    expect(arg.args).toBeUndefined()
  })

  it("Cancel closes the dialog without calling onAdd", () => {
    const onOpenChange = jest.fn()
    const onAdd = jest.fn()
    render(<AddLspDialog open onOpenChange={onOpenChange} onAdd={onAdd} />)
    fireEvent.click(screen.getByRole("button", { name: "cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onAdd).not.toHaveBeenCalled()
  })
})
