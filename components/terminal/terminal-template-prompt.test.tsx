import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { TerminalTemplatePrompt } from "./terminal-template-prompt"
import type { TemplateVariable } from "@/lib/terminal/template-engine"

const messages = {
  terminal: {
    template: {
      title: "Fill template variables",
      inputPlaceholder: "Enter value",
      selectPlaceholder: "Choose an option",
      cancel: "Cancel",
      run: "Run",
    },
  },
}

function renderPrompt(props: Partial<React.ComponentProps<typeof TerminalTemplatePrompt>> = {}) {
  const defaultVars: TemplateVariable[] = [{ raw: "${input:name}", kind: "input", label: "name" }]
  const defaultProps = {
    open: true,
    onOpenChange: jest.fn(),
    variables: defaultVars,
    onSubmit: jest.fn(),
    ...props,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TerminalTemplatePrompt {...defaultProps} />
    </NextIntlClientProvider>
  )
}

describe("TerminalTemplatePrompt", () => {
  it("renders the dialog when open", () => {
    renderPrompt()
    expect(screen.getByTestId("template-prompt-dialog")).toBeInTheDocument()
  })

  it("does not render when closed", () => {
    renderPrompt({ open: false })
    expect(screen.queryByTestId("template-prompt-dialog")).not.toBeInTheDocument()
  })

  it("renders an input for each input variable", () => {
    renderPrompt({
      variables: [
        { raw: "${input:host}", kind: "input", label: "host" },
        { raw: "${input:port}", kind: "input", label: "port", defaultValue: "3000" },
      ],
    })
    expect(screen.getByTestId("template-input-host")).toBeInTheDocument()
    expect(screen.getByTestId("template-input-port")).toBeInTheDocument()
  })

  it("renders a select for select variables", () => {
    renderPrompt({
      variables: [
        {
          raw: "${select:env:dev,staging,prod}",
          kind: "select",
          label: "env",
          options: ["dev", "staging", "prod"],
        },
      ],
    })
    expect(screen.getByTestId("template-select-env")).toBeInTheDocument()
  })

  it("pre-fills default values for inputs", () => {
    renderPrompt({
      variables: [{ raw: "${input:port}", kind: "input", label: "port", defaultValue: "8080" }],
    })
    const input = screen.getByTestId("template-input-port") as HTMLInputElement
    expect(input.value).toBe("8080")
  })

  it("calls onSubmit with values when form is submitted", () => {
    const onSubmit = jest.fn()
    renderPrompt({
      onSubmit,
      variables: [{ raw: "${input:name}", kind: "input", label: "name" }],
    })
    const input = screen.getByTestId("template-input-name")
    fireEvent.change(input, { target: { value: "my-app" } })
    fireEvent.click(screen.getByTestId("template-submit"))
    expect(onSubmit).toHaveBeenCalledWith({ "${input:name}": "my-app" })
  })

  it("calls onOpenChange(false) when cancel is clicked", () => {
    const onOpenChange = jest.fn()
    renderPrompt({ onOpenChange })
    fireEvent.click(screen.getByTestId("template-cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("shows the template string in description when provided", () => {
    renderPrompt({ template: "docker exec -it ${input:name} bash" })
    expect(screen.getByText("docker exec -it ${input:name} bash")).toBeInTheDocument()
  })

  it("does not render non-interactive vars (env, cwd, etc.)", () => {
    renderPrompt({
      variables: [
        { raw: "${env:HOME}", kind: "env", label: "HOME" },
        { raw: "${input:name}", kind: "input", label: "name" },
      ],
    })
    expect(screen.getByTestId("template-input-name")).toBeInTheDocument()
    // env var should not produce a form field
    expect(screen.queryByText("HOME")).not.toBeInTheDocument()
  })
})
