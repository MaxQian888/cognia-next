/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const setImportStaging = jest.fn()
jest.mock("@/stores/plugins", () => ({
  usePluginsStore: (selector: (s: unknown) => unknown) => selector({ setImportStaging }),
}))

import { PluginInstallFromUrlDialog } from "./plugin-install-from-url-dialog"

const originalFetch = global.fetch

describe("PluginInstallFromUrlDialog", () => {
  beforeEach(() => {
    setImportStaging.mockClear()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("does not render when closed", () => {
    render(<PluginInstallFromUrlDialog open={false} onOpenChange={() => {}} />)
    expect(screen.queryByText("title")).not.toBeInTheDocument()
  })

  it("renders title, label, and submit button when open", () => {
    render(<PluginInstallFromUrlDialog open={true} onOpenChange={() => {}} />)
    expect(screen.getByText("title")).toBeInTheDocument()
    expect(screen.getByText("label")).toBeInTheDocument()
    expect(screen.getByText("submit")).toBeInTheDocument()
  })

  it("shows empty error when submitted without URL", () => {
    render(<PluginInstallFromUrlDialog open={true} onOpenChange={() => {}} />)
    fireEvent.click(screen.getByText("submit"))
    expect(screen.getByRole("alert")).toHaveTextContent("emptyError")
    expect(setImportStaging).not.toHaveBeenCalled()
  })

  it("submits and stages manifest on success", async () => {
    const onOpenChange = jest.fn()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "p", name: "P", version: "1.0.0" }),
    }) as unknown as typeof fetch
    render(<PluginInstallFromUrlDialog open={true} onOpenChange={onOpenChange} />)
    fireEvent.change(screen.getByLabelText("label"), {
      target: { value: "https://example.com/plugin.json" },
    })
    fireEvent.click(screen.getByText("submit"))
    await waitFor(() =>
      expect(setImportStaging).toHaveBeenCalledWith(
        expect.objectContaining({
          drafts: [
            expect.objectContaining({
              id: "p",
              name: "P",
              version: "1.0.0",
              sourceLabel: "https://example.com/plugin.json",
            }),
          ],
        })
      )
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("falls back to URL as id/name when manifest omits them", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }) as unknown as typeof fetch
    render(<PluginInstallFromUrlDialog open={true} onOpenChange={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("label"), {
      target: { value: "https://example.com/p.json" },
    })
    fireEvent.click(screen.getByText("submit"))
    await waitFor(() => expect(setImportStaging).toHaveBeenCalled())
    const [[arg]] = setImportStaging.mock.calls
    expect(arg.drafts[0].id).toBe("https://example.com/p.json")
    expect(arg.drafts[0].version).toBe("0.0.0")
  })

  it("renders error message on HTTP failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 404,
    }) as unknown as typeof fetch
    render(<PluginInstallFromUrlDialog open={true} onOpenChange={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("label"), {
      target: { value: "https://example.com/missing.json" },
    })
    fireEvent.click(screen.getByText("submit"))
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
    expect(setImportStaging).not.toHaveBeenCalled()
  })

  it("renders error on network failure", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch
    render(<PluginInstallFromUrlDialog open={true} onOpenChange={jest.fn()} />)
    fireEvent.change(screen.getByLabelText("label"), {
      target: { value: "https://example.com/p.json" },
    })
    fireEvent.click(screen.getByText("submit"))
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
  })

  it("Enter key submits", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "p" }),
    }) as unknown as typeof fetch
    render(<PluginInstallFromUrlDialog open={true} onOpenChange={jest.fn()} />)
    const input = screen.getByLabelText("label")
    fireEvent.change(input, { target: { value: "https://example.com/p.json" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(setImportStaging).toHaveBeenCalled())
  })

  it("cancel button closes the dialog", () => {
    const onOpenChange = jest.fn()
    render(<PluginInstallFromUrlDialog open={true} onOpenChange={onOpenChange} />)
    fireEvent.click(screen.getByText("cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
