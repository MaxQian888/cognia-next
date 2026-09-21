/** @jest-environment jsdom */

// The declaration row edits what a `{{token}}` cannot say about itself: label,
// required, kind, and the per-kind fields (options / resource kind / default).

import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
// Radix Select needs pointer APIs jsdom lacks — native <select> stand-in.
jest.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string
    onValueChange?: (v: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({ className }: { className?: string }) => (
    <span data-testid="select-trigger" className={className} />
  ),
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}))

import { ParamDeclarationRow } from "./param-declaration-row"
import type { ChatTemplateParam } from "@/lib/chat/template/template"

const base: ChatTemplateParam = { id: "module", label: "Module", required: true, kind: "string" }

function renderRow(param: ChatTemplateParam = base, mobile = false) {
  const onPatch = jest.fn()
  render(<ParamDeclarationRow param={param} mobile={mobile} onPatch={onPatch} />)
  return onPatch
}

describe("ParamDeclarationRow", () => {
  it("patches the label", () => {
    const onPatch = renderRow()
    fireEvent.change(screen.getByLabelText("paramLabel"), { target: { value: "Which module" } })
    expect(onPatch).toHaveBeenCalledWith({ label: "Which module" })
  })

  it("patches required only on a real check", () => {
    const onPatch = renderRow()
    fireEvent.click(screen.getByRole("checkbox", { name: "paramRequired" }))
    expect(onPatch).toHaveBeenCalledWith({ required: false })
  })

  it("shows the default+multiline fields for a string parameter", () => {
    const onPatch = renderRow()
    fireEvent.change(screen.getByLabelText("paramDefault"), { target: { value: "main" } })
    expect(onPatch).toHaveBeenCalledWith({ defaultValue: "main" })

    fireEvent.click(screen.getByRole("checkbox", { name: "paramMultiline" }))
    expect(onPatch).toHaveBeenCalledWith({ multiline: true })
  })

  it("clears a default back to undefined when emptied", () => {
    const onPatch = renderRow({ ...base, defaultValue: "main" })
    fireEvent.change(screen.getByLabelText("paramDefault"), { target: { value: "" } })
    expect(onPatch).toHaveBeenCalledWith({ defaultValue: undefined })
  })

  it("patches the fill hint and clears it to undefined", () => {
    const onPatch = renderRow({ ...base, description: "the service" })
    const hint = screen.getByLabelText("paramHint")
    expect(hint).toHaveValue("the service")
    fireEvent.change(hint, { target: { value: "the service to deploy" } })
    expect(onPatch).toHaveBeenCalledWith({ description: "the service to deploy" })
    fireEvent.change(hint, { target: { value: "" } })
    expect(onPatch).toHaveBeenCalledWith({ description: undefined })
  })

  it("shows the options textarea for an enum parameter", () => {
    const onPatch = renderRow({ ...base, kind: "enum", options: ["a"] })
    fireEvent.change(screen.getByLabelText("paramOptions"), { target: { value: "a\nb\n\n" } })
    expect(onPatch).toHaveBeenCalledWith({ options: ["a", "b"] })
  })

  it("shows the resource-kind picker for a resource parameter", () => {
    renderRow({ ...base, kind: "resource", resourceKind: "file" })
    // The kind select comes first, the resource-kind select second.
    expect(screen.getAllByRole("combobox")).toHaveLength(2)
  })

  it("patches the resource kind through its picker", () => {
    const onPatch = renderRow({ ...base, kind: "resource", resourceKind: "file" })
    const [, resourceSelect] = screen.getAllByRole("combobox")
    fireEvent.change(resourceSelect, { target: { value: "agent" } })
    expect(onPatch).toHaveBeenCalledWith({ resourceKind: "agent" })
  })

  it("patches the parameter kind, defaulting the resource source", () => {
    const onPatch = renderRow()
    const [kindSelect] = screen.getAllByRole("combobox")
    fireEvent.change(kindSelect, { target: { value: "resource" } })
    // paramKindChange fills in a source so the picker never opens on nothing.
    expect(onPatch).toHaveBeenCalledWith({ kind: "resource", resourceKind: "file" })
  })

  it("defaults the picker to file when no resource kind was declared", () => {
    renderRow({ ...base, kind: "resource" })
    const [, resourceSelect] = screen.getAllByRole("combobox")
    expect(resourceSelect).toHaveValue("file")
  })

  it("lets an enum parameter have no options yet", () => {
    renderRow({ ...base, kind: "enum" })
    expect(screen.getByLabelText("paramOptions")).toHaveValue("")
  })

  it("stretches the resource picker full-width on mobile", () => {
    renderRow({ ...base, kind: "resource", resourceKind: "file" }, true)
    // The width lives on the trigger, which the mock exposes as a span.
    const triggers = screen.getAllByTestId("select-trigger")
    expect(triggers[1].className).toContain("w-full")
  })
})
