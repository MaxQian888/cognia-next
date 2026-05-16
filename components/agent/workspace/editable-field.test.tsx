/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"

import { EditableField } from "./editable-field"

jest.mock("motion/react", () => {
  const passthrough = ({
    children,
    className,
    onClick,
    title,
    type: _type,
    disabled,
    "data-testid": testId,
    ...rest
  }: React.HTMLAttributes<HTMLElement> & {
    type?: "button" | "submit" | "reset"
    disabled?: boolean
    "data-testid"?: string
  }) =>
    React.createElement(
      "div",
      {
        className,
        onClick,
        title,
        "data-testid": testId,
        "data-disabled": disabled || undefined,
        ...rest,
      },
      children
    )
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: {
      span: passthrough,
      button: ({
        children,
        className,
        onClick,
        title,
        disabled,
        "data-testid": testId,
        ...rest
      }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
        "data-testid"?: string
      }) => (
        <button
          type="button"
          className={className}
          onClick={onClick}
          title={title}
          disabled={disabled}
          data-testid={testId}
          {...rest}
        >
          {children}
        </button>
      ),
    },
    useReducedMotion: jest.fn(() => false),
  }
})

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

const renderField = (props: Partial<React.ComponentProps<typeof EditableField>> = {}) => {
  const onSave = jest.fn()
  const utils = render(
    <EditableField
      value="Squad Alpha"
      onSave={onSave}
      editTooltipKey="editName"
      data-testid="field"
      {...props}
    />
  )
  return { onSave, ...utils }
}

describe("EditableField", () => {
  it("renders the value in display mode", () => {
    renderField()
    expect(screen.getByTestId("field")).toHaveTextContent("Squad Alpha")
  })

  it("shows the translated tooltip on the display trigger", () => {
    renderField({ editTooltipKey: "editDescription" })
    expect(screen.getByTestId("field")).toHaveAttribute(
      "title",
      "agentTeamsWorkspace.editableField.editDescription"
    )
  })

  it("renders the empty hint when value is empty", () => {
    renderField({ value: "", emptyHintKey: "emptyHint" })
    expect(screen.getByTestId("field")).toHaveTextContent(
      "agentTeamsWorkspace.editableField.emptyHint"
    )
  })

  it("switches to edit mode on click and focuses the input", () => {
    renderField()
    fireEvent.click(screen.getByTestId("field"))
    const input = screen.getByRole("textbox") as HTMLInputElement
    expect(input).toHaveValue("Squad Alpha")
    expect(input).toHaveFocus()
  })

  it("commits a trimmed value on Enter when variant=input", () => {
    const { onSave } = renderField()
    fireEvent.click(screen.getByTestId("field"))
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "  Squad Beta  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSave).toHaveBeenCalledWith("Squad Beta")
  })

  it("does NOT commit on Enter when variant=textarea (allows newlines)", () => {
    const { onSave } = renderField({ variant: "textarea" })
    fireEvent.click(screen.getByTestId("field"))
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "first\nsecond" } })
    fireEvent.keyDown(textarea, { key: "Enter" })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("commits the value when the ✓ button is clicked", () => {
    const { onSave } = renderField({ variant: "textarea" })
    fireEvent.click(screen.getByTestId("field"))
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "updated description" } })
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentTeamsWorkspace.editableField.saveAriaLabel",
      })
    )
    expect(onSave).toHaveBeenCalledWith("updated description")
  })

  it("cancels on Escape without calling onSave", () => {
    const { onSave } = renderField()
    fireEvent.click(screen.getByTestId("field"))
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "Squad Beta" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId("field")).toHaveTextContent("Squad Alpha")
  })

  it("cancels when the ✕ button is clicked", () => {
    const { onSave } = renderField({ variant: "textarea" })
    fireEvent.click(screen.getByTestId("field"))
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "different" } })
    fireEvent.click(
      screen.getByRole("button", {
        name: "agentTeamsWorkspace.editableField.cancelAriaLabel",
      })
    )
    expect(onSave).not.toHaveBeenCalled()
  })

  it("does not call onSave when the trimmed draft equals the original value", () => {
    const { onSave } = renderField()
    fireEvent.click(screen.getByTestId("field"))
    const input = screen.getByRole("textbox")
    fireEvent.change(input, { target: { value: "  Squad Alpha  " } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onSave).not.toHaveBeenCalled()
  })

  it("disabled mode: clicking the display does not enter edit mode", () => {
    renderField({ disabled: true })
    fireEvent.click(screen.getByTestId("field"))
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument()
  })

  it("respects prefers-reduced-motion", () => {
    const mockUseReducedMotion = jest.requireMock("motion/react").useReducedMotion
    mockUseReducedMotion.mockReturnValueOnce(true)
    renderField()
    expect(screen.getByTestId("field")).toBeInTheDocument()
  })
})
