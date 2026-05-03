/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    if (vars && typeof vars.name === "string") return `${key}:${vars.name}`
    return key
  },
}))

import { PluginDeleteDialog } from "./plugin-delete-dialog"

describe("PluginDeleteDialog", () => {
  it("renders title and body when open", () => {
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("body:Alpha")).toBeInTheDocument()
  })

  it("clicking confirm invokes onConfirm with cascade=false by default", () => {
    const onConfirm = jest.fn()
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={() => {}} onConfirm={onConfirm} />)
    fireEvent.click(screen.getByText("confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ cascade: false })
  })

  it("toggling cascade and confirming passes cascade=true", () => {
    const onConfirm = jest.fn()
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={() => {}} onConfirm={onConfirm} />)
    const cascadeBox = screen.getByLabelText(/cascadeLabel/) as HTMLInputElement
    fireEvent.click(cascadeBox)
    fireEvent.click(screen.getByText("confirm"))
    expect(onConfirm).toHaveBeenCalledWith({ cascade: true })
  })

  it("clicking cancel invokes onCancel", () => {
    const onCancel = jest.fn()
    render(<PluginDeleteDialog open pluginName="Alpha" onCancel={onCancel} onConfirm={() => {}} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onCancel).toHaveBeenCalled()
  })
})
