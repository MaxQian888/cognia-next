/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { McpServerEditor } from "./mcp-server-editor"
import type { McpEditorInitial } from "./mcp-server-utils"

const base: McpEditorInitial = {
  name: "github",
  transport: "stdio",
  config: { command: "npx", args: ["-y", "server-github"], env: { TOKEN: "t" } },
  enabled: true,
  appsEnabled: {},
  disallowedTools: ["browser_run_code_unsafe"],
}

beforeEach(() => {
  ;(toast.error as jest.Mock).mockReset()
})

describe("McpServerEditor", () => {
  it("hydrates the form from the initial server", () => {
    render(<McpServerEditor initial={base} onCancel={jest.fn()} onSave={jest.fn()} />)
    expect(screen.getByDisplayValue("github")).toBeInTheDocument()
    expect(screen.getByDisplayValue("npx")).toBeInTheDocument()
    // env rows hydrate into the KvEditor inputs
    expect(screen.getByDisplayValue("TOKEN")).toBeInTheDocument()
  })

  it("wires placeholders to i18n keys (no hard-coded examples)", () => {
    render(
      <McpServerEditor initial={{ ...base, name: "" }} onCancel={jest.fn()} onSave={jest.fn()} />
    )
    expect(screen.getByPlaceholderText("placeholderName")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("placeholderCommand")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("placeholderArgs")).toBeInTheDocument()
  })

  it("rejects an empty name", async () => {
    const onSave = jest.fn()
    render(<McpServerEditor initial={{ ...base, name: "" }} onCancel={jest.fn()} onSave={onSave} />)
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nameRequired"))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("builds a clean stdio config on save", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(<McpServerEditor initial={base} onCancel={jest.fn()} onSave={onSave} />)
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const arg = onSave.mock.calls[0][0]
    expect(arg.name).toBe("github")
    expect(arg.transport).toBe("stdio")
    expect(arg.config.command).toBe("npx")
    expect(arg.config.env).toEqual({ TOKEN: "t" })
    expect(arg.disallowedTools).toEqual(["browser_run_code_unsafe"])
  })

  it("edits server-level disallowed tools as one bare name per line", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(<McpServerEditor initial={base} onCancel={jest.fn()} onSave={onSave} />)
    const input = screen.getByLabelText("disallowedTools")
    expect(input).toHaveValue("browser_run_code_unsafe")
    fireEvent.change(input, {
      target: { value: "browser_run_code_unsafe\nbrowser_evaluate\nbrowser_evaluate" },
    })
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    expect(onSave.mock.calls[0][0].disallowedTools).toEqual([
      "browser_run_code_unsafe",
      "browser_evaluate",
    ])
  })

  it("calls onCancel", () => {
    const onCancel = jest.fn()
    render(<McpServerEditor initial={base} onCancel={onCancel} onSave={jest.fn()} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onCancel).toHaveBeenCalled()
  })

  it("toggles to JSON view and back", () => {
    render(<McpServerEditor initial={base} onCancel={jest.fn()} onSave={jest.fn()} />)
    fireEvent.click(screen.getByText("showJson"))
    // Now a JSON textarea should hold the serialized config.
    expect(screen.getByDisplayValue(/"command": "npx"/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("showForm"))
    expect(screen.getByDisplayValue("npx")).toBeInTheDocument()
  })

  it("surfaces an error when reverting invalid JSON to the form", async () => {
    render(<McpServerEditor initial={base} onCancel={jest.fn()} onSave={jest.fn()} />)
    fireEvent.click(screen.getByText("showJson"))
    const ta = screen.getByDisplayValue(/"command": "npx"/)
    fireEvent.change(ta, { target: { value: "{ not json" } })
    fireEvent.click(screen.getByText("showForm"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("jsonRevertFailed"))
    )
  })

  it("rejects invalid JSON on save", async () => {
    render(<McpServerEditor initial={base} onCancel={jest.fn()} onSave={jest.fn()} />)
    fireEvent.click(screen.getByText("showJson"))
    fireEvent.change(screen.getByDisplayValue(/"command": "npx"/), { target: { value: "{bad" } })
    fireEvent.click(screen.getByText("save"))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("invalidJson"))
    )
  })

  const httpBase: McpEditorInitial = {
    name: "remote",
    transport: "http",
    config: { url: "https://x/mcp", headers: { Authorization: "Bearer y" } },
    enabled: true,
    appsEnabled: {},
    disallowedTools: [],
  }

  it("hydrates and saves an http server with headers", async () => {
    const onSave = jest.fn().mockResolvedValue(undefined)
    render(<McpServerEditor initial={httpBase} onCancel={jest.fn()} onSave={onSave} />)
    expect(screen.getByDisplayValue("https://x/mcp")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Authorization")).toBeInTheDocument()
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(onSave).toHaveBeenCalled())
    const arg = onSave.mock.calls[0][0]
    expect(arg.transport).toBe("http")
    expect(arg.config).toEqual({ url: "https://x/mcp", headers: { Authorization: "Bearer y" } })
  })

  it("requires a url for http transport", async () => {
    render(
      <McpServerEditor
        initial={{ ...httpBase, config: {} }}
        onCancel={jest.fn()}
        onSave={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("urlRequired"))
  })

  it("requires a command for stdio transport", async () => {
    render(
      <McpServerEditor
        initial={{ ...base, config: { args: [] } }}
        onCancel={jest.fn()}
        onSave={jest.fn()}
      />
    )
    fireEvent.click(screen.getByText("save"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("commandRequired"))
  })
})
