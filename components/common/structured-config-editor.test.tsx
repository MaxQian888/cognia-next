/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { z } from "zod"

import { StructuredConfigEditor } from "./structured-config-editor"

const downloadBlob = jest.fn()

jest.mock("@/lib/files/download", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/ai-elements/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="preview">{code}</pre>,
  CodeBlockActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockCopyButton: () => <button type="button">copy</button>,
  CodeBlockFilename: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  CodeBlockHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CodeBlockTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

const schema = z.object({ name: z.string().min(1), enabled: z.boolean() }).strict()

function setup(
  options: {
    onApply?: jest.Mock
    disabled?: boolean
    value?: { name: string; enabled: boolean }
  } = {}
) {
  const onApply = options.onApply ?? jest.fn().mockResolvedValue(undefined)
  const view = render(
    <StructuredConfigEditor
      value={options.value ?? { name: "edge", enabled: true }}
      validate={(value) => schema.parse(value)}
      onApply={onApply}
      filename="gateway-config"
      disabled={options.disabled}
    />
  )
  return { onApply, ...view }
}

describe("StructuredConfigEditor", () => {
  beforeEach(() => downloadBlob.mockReset())

  it("keeps invalid drafts visible and applies only validated values", async () => {
    const user = userEvent.setup()
    const { onApply } = setup()
    const editor = screen.getByLabelText("editorLabel")

    fireEvent.change(editor, { target: { value: '{"name":"edge"}' } })
    await user.click(screen.getByRole("button", { name: "apply" }))

    expect(onApply).not.toHaveBeenCalled()
    expect(editor).toHaveValue('{"name":"edge"}')
    expect(screen.getByRole("alert")).toHaveTextContent("invalid")

    fireEvent.change(editor, {
      target: { value: '{"name":"custom","enabled":false}' },
    })
    await user.click(screen.getByRole("button", { name: "apply" }))

    await waitFor(() => expect(onApply).toHaveBeenCalledWith({ name: "custom", enabled: false }))
  })

  it("converts a valid draft between JSON and YAML without losing its value", async () => {
    const user = userEvent.setup()
    setup()

    await user.click(screen.getByRole("combobox", { name: "format" }))
    await user.click(screen.getByRole("option", { name: "yaml" }))

    expect((screen.getByLabelText("editorLabel") as HTMLTextAreaElement).value).toContain(
      "name: edge"
    )
  })

  it("keeps the current format when the draft cannot be validated", async () => {
    const user = userEvent.setup()
    setup()
    fireEvent.change(screen.getByLabelText("editorLabel"), { target: { value: "{" } })

    await user.click(screen.getByRole("combobox", { name: "format" }))
    await user.click(screen.getByRole("option", { name: "yaml" }))

    expect(screen.getByRole("combobox", { name: "format" })).toHaveTextContent("json")
    expect(screen.getByRole("alert")).toHaveTextContent("invalid")
  })

  it("normalizes non-Error validation failures", async () => {
    const user = userEvent.setup()
    render(
      <StructuredConfigEditor
        value={{ name: "edge", enabled: true }}
        validate={() => {
          throw "invalid value"
        }}
        onApply={jest.fn()}
        filename="gateway-config"
      />
    )

    await user.click(screen.getByRole("button", { name: "validate" }))
    expect(screen.getByRole("alert")).toHaveTextContent("invalid value")
  })

  it("imports a supported configuration file into the draft", async () => {
    setup()
    const file = new File([], "config.json", { type: "application/json" })
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve('{"name":"imported","enabled":false}'),
    })

    fireEvent.change(screen.getByLabelText("import"), { target: { files: [file] } })

    await waitFor(() =>
      expect((screen.getByLabelText("editorLabel") as HTMLTextAreaElement).value).toContain(
        '"name": "imported"'
      )
    )
  })

  it("imports YAML and reports invalid imported files without replacing the draft", async () => {
    const { rerender } = setup()
    const yaml = new File([], "config.yaml", { type: "application/yaml" })
    Object.defineProperty(yaml, "text", {
      value: () => Promise.resolve("name: imported\nenabled: false\n"),
    })
    fireEvent.change(screen.getByLabelText("import"), { target: { files: [yaml] } })
    await waitFor(() =>
      expect((screen.getByLabelText("editorLabel") as HTMLTextAreaElement).value).toContain(
        "name: imported"
      )
    )

    const invalid = new File([], "broken.json", { type: "application/json" })
    Object.defineProperty(invalid, "text", { value: () => Promise.resolve("{") })
    fireEvent.change(screen.getByLabelText("import"), { target: { files: [invalid] } })
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("invalid"))
    expect((screen.getByLabelText("editorLabel") as HTMLTextAreaElement).value).toContain(
      "name: imported"
    )

    rerender(
      <StructuredConfigEditor
        value={{ name: "external", enabled: true }}
        validate={(value) => schema.parse(value)}
        onApply={jest.fn()}
        filename="gateway-config"
      />
    )
    await waitFor(() =>
      expect((screen.getByLabelText("editorLabel") as HTMLTextAreaElement).value).toContain(
        "name: imported"
      )
    )
  })

  it("normalizes non-Error file import failures", async () => {
    setup()
    const file = new File([], "broken.yaml", { type: "application/yaml" })
    Object.defineProperty(file, "text", { value: () => Promise.reject("read failed") })

    fireEvent.change(screen.getByLabelText("import"), { target: { files: [file] } })

    expect(await screen.findByRole("alert")).toHaveTextContent("read failed")
  })

  it("surfaces apply failures and disables mutating controls", async () => {
    const user = userEvent.setup()
    const onApply = jest.fn().mockRejectedValue("write failed")
    const { rerender } = setup({ onApply })

    await user.click(screen.getByRole("button", { name: "apply" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("write failed")

    rerender(
      <StructuredConfigEditor
        value={{ name: "edge", enabled: true }}
        validate={(value) => schema.parse(value)}
        onApply={onApply}
        filename="gateway-config"
        disabled
      />
    )
    expect(screen.getByRole("button", { name: "import" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "download" })).toBeDisabled()
    fireEvent.change(screen.getByLabelText("import"), { target: { files: [] } })
  })

  it("previews, resets, and exports the last valid configuration", async () => {
    const user = userEvent.setup()
    setup()

    fireEvent.change(screen.getByLabelText("editorLabel"), {
      target: { value: '{"name":"preview","enabled":false}' },
    })
    await user.click(screen.getByRole("button", { name: "validate" }))
    expect(screen.getByTestId("preview")).toHaveTextContent('"name": "preview"')

    await user.click(screen.getByRole("button", { name: "download" }))
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "gateway-config.json")

    await user.click(screen.getByRole("button", { name: "reset" }))
    expect((screen.getByLabelText("editorLabel") as HTMLTextAreaElement).value).toContain(
      '"name": "edge"'
    )
  })
})
