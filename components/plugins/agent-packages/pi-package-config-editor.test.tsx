/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import messages from "@/i18n/messages/en.json"
import { PiPackageConfigEditor } from "./pi-package-config-editor"

// Monaco needs a real layout engine and loads workers; the editor is replaced
// by a textarea so the surrounding behaviour (load, template insert, parse
// refusal, save) is what gets asserted.
jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  default: ({ value, onChange }: { value: string; onChange: (next: string) => void }) => (
    <textarea
      data-testid="monaco-stub"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}))

jest.mock("@/lib/canvas/monaco-loader", () => ({ configureMonacoLoader: jest.fn() }))

// `jest.mock` is hoisted above the module body, so the factory has to build the
// mock itself rather than close over a const declared here.
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))
const toastMock = jest.requireMock("sonner").toast as {
  success: jest.Mock
  error: jest.Mock
}

interface Options {
  spec?: string | null
  path?: string | null
  existing?: string | null
}

function renderEditor(options: Options = {}) {
  const io = {
    exists: jest.fn(async () => options.existing != null),
    readTextFile: jest.fn(async () => options.existing ?? ""),
    writeTextFile: jest.fn(async () => undefined),
  }
  const onClose = jest.fn()
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PiPackageConfigEditor
        spec={options.spec === undefined ? "npm:@narumitw/pi-statusline@0.49.6" : options.spec}
        path={options.path === undefined ? "/home/u/.pi/agent/pi-statusline.json" : options.path}
        onClose={onClose}
        io={io}
      />
    </NextIntlClientProvider>
  )
  return { io, onClose }
}

beforeEach(() => jest.clearAllMocks())

describe("PiPackageConfigEditor", () => {
  it("renders nothing without a spec", () => {
    renderEditor({ spec: null })
    expect(screen.queryByTestId("pi-config-editor")).not.toBeInTheDocument()
  })

  it("renders nothing without a path", () => {
    renderEditor({ path: null })
    expect(screen.queryByTestId("pi-config-editor")).not.toBeInTheDocument()
  })

  it("loads the existing file", async () => {
    const { io } = renderEditor({ existing: '{"density":"compact"}' })
    await waitFor(() =>
      expect(screen.getByTestId("monaco-stub")).toHaveValue('{"density":"compact"}')
    )
    expect(io.readTextFile).toHaveBeenCalledWith("/home/u/.pi/agent/pi-statusline.json")
  })

  it("starts empty when the file does not exist yet", async () => {
    const { io } = renderEditor({ existing: null })
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toHaveValue(""))
    expect(io.readTextFile).not.toHaveBeenCalled()
  })

  it("shows the absolute path being edited", async () => {
    renderEditor({ existing: "" })
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toBeInTheDocument())
    expect(screen.getByText("/home/u/.pi/agent/pi-statusline.json")).toBeInTheDocument()
  })

  /**
   * These files are each extension's own convention, not a Pi contract — the
   * dialog must say so rather than implying a schema exists.
   */
  it("says there is no schema to validate against", async () => {
    renderEditor({ existing: "" })
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toBeInTheDocument())
    expect(screen.getByText(/not a Pi contract/i)).toBeInTheDocument()
  })

  it("inserts the reviewed defaults for a package that has them", async () => {
    renderEditor({ existing: "" })
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toBeInTheDocument())
    await userEvent.click(screen.getByTestId("pi-config-insert-template"))
    const value = (screen.getByTestId("monaco-stub") as HTMLTextAreaElement).value
    expect(JSON.parse(value)).toMatchObject({ density: "compact" })
  })

  it("disables the template button for a package with no reviewed defaults", async () => {
    renderEditor({ spec: "npm:pi-atelier@0.8.1", existing: "" })
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toBeInTheDocument())
    expect(screen.getByTestId("pi-config-insert-template")).toBeDisabled()
  })

  it("writes valid JSON and closes", async () => {
    const { io, onClose } = renderEditor({ existing: '{"a":1}' })
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toHaveValue('{"a":1}'))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(io.writeTextFile).toHaveBeenCalledWith(
      "/home/u/.pi/agent/pi-statusline.json",
      '{"a":1}\n'
    )
  })

  /**
   * These files are read at Pi startup, so a trailing comma here surfaces as a
   * broken extension minutes later with nothing pointing back at this editor.
   */
  it("refuses to save invalid JSON", async () => {
    const { io, onClose } = renderEditor({ existing: "" })
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toBeInTheDocument())
    // `userEvent.type` reads `{` as a key descriptor, so set the value directly.
    fireEvent.change(screen.getByTestId("monaco-stub"), { target: { value: '{"a":1,}' } })
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(screen.getByTestId("pi-config-parse-error")).toBeInTheDocument()
    expect(io.writeTextFile).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it("allows saving an empty file, which means no configuration", async () => {
    const { io } = renderEditor({ existing: "" })
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toBeInTheDocument())
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(io.writeTextFile).toHaveBeenCalled())
  })

  it("surfaces a write failure without closing", async () => {
    const io = {
      exists: jest.fn(async () => true),
      readTextFile: jest.fn(async () => "{}"),
      writeTextFile: jest.fn(async () => {
        throw new Error("read-only file system")
      }),
    }
    const onClose = jest.fn()
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <PiPackageConfigEditor
          spec="npm:pi-goal@0.51.0"
          path="/home/u/.pi/agent/pi-goal.json"
          onClose={onClose}
          io={io}
        />
      </NextIntlClientProvider>
    )
    await waitFor(() => expect(screen.getByTestId("monaco-stub")).toHaveValue("{}"))
    await userEvent.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith("read-only file system"))
    expect(onClose).not.toHaveBeenCalled()
  })
})
