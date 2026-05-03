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

// The radix DropdownMenu uses pointer events that fireEvent.click does not
// drive — render its content unconditionally so the menu items are always in
// the DOM tree, matching the pattern used by other tests in this repo.
jest.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <button>{children}</button>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dropdown-content">{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onClick,
  }: {
    children: React.ReactNode
    onClick?: () => void
    className?: string
  }) => <button onClick={onClick}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
}))

// Stub the inner URL dialog — its behavior has its own dedicated test file.
jest.mock("./plugin-install-from-url-dialog", () => ({
  PluginInstallFromUrlDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (o: boolean) => void
  }) =>
    open ? (
      <div data-testid="url-dialog">
        <button onClick={() => onOpenChange(false)}>close-dialog</button>
      </div>
    ) : null,
}))

import { PluginPanelToolbar } from "./plugin-panel-toolbar"

// Cache the prototype createElement once at module load — before any spy
// can replace the instance property — so file-install tests can stub
// individual inputs without recursing through their own mock.
const realCreateElement = Document.prototype.createElement

function spyOnInputCreation(): {
  inputs: HTMLInputElement[]
  restore: () => void
} {
  const inputs: HTMLInputElement[] = []
  const spy = jest.spyOn(Document.prototype, "createElement").mockImplementation(function (
    this: Document,
    tag: string,
    ...rest: unknown[]
  ) {
    const el = realCreateElement.apply(this, [tag, ...rest] as Parameters<
      typeof realCreateElement
    >) as HTMLElement
    if (tag === "input") {
      const input = el as HTMLInputElement
      input.click = jest.fn()
      inputs.push(input)
    }
    return el as ReturnType<typeof realCreateElement>
  })
  return { inputs, restore: () => spy.mockRestore() }
}

describe("PluginPanelToolbar", () => {
  beforeEach(() => {
    setImportStaging.mockClear()
  })

  it("renders install dropdown trigger and update / sync buttons", () => {
    render(<PluginPanelToolbar />)
    expect(screen.getByText("install")).toBeInTheDocument()
    expect(screen.getByText("checkUpdates")).toBeInTheDocument()
    expect(screen.getByText("syncRegistry")).toBeInTheDocument()
  })

  it("clicking checkUpdates invokes onCheckUpdates", () => {
    const onCheckUpdates = jest.fn()
    render(<PluginPanelToolbar onCheckUpdates={onCheckUpdates} />)
    fireEvent.click(screen.getByText("checkUpdates"))
    expect(onCheckUpdates).toHaveBeenCalled()
  })

  it("syncRegistry button is disabled when no handler is provided", () => {
    render(<PluginPanelToolbar />)
    const sync = screen.getAllByRole("button").find((b) => b.textContent?.includes("syncRegistry"))!
    expect(sync).toBeDisabled()
  })

  it("syncRegistry calls handler when provided", async () => {
    const onSyncRegistry = jest.fn().mockResolvedValue(undefined)
    render(<PluginPanelToolbar onSyncRegistry={onSyncRegistry} />)
    const sync = screen.getAllByRole("button").find((b) => b.textContent?.includes("syncRegistry"))!
    expect(sync).not.toBeDisabled()
    fireEvent.click(sync)
    await waitFor(() => expect(onSyncRegistry).toHaveBeenCalled())
  })

  it("syncRegistry button is disabled while syncing prop is true", () => {
    render(<PluginPanelToolbar onSyncRegistry={jest.fn()} syncing={true} />)
    const sync = screen.getAllByRole("button").find((b) => b.textContent?.includes("syncRegistry"))!
    expect(sync).toBeDisabled()
  })

  it("From URL menu item opens the URL dialog", async () => {
    render(<PluginPanelToolbar />)
    fireEvent.click(screen.getByText("fromUrl"))
    expect(await screen.findByTestId("url-dialog")).toBeInTheDocument()
  })

  it("From File menu item opens a file picker accepting only JSON", async () => {
    render(<PluginPanelToolbar />)
    const { inputs, restore } = spyOnInputCreation()
    fireEvent.click(screen.getByText("fromFile"))
    await waitFor(() => expect(inputs.length).toBeGreaterThan(0))
    const input = inputs[inputs.length - 1]
    expect(input.accept).toBe(".json,application/json")
    input.oncancel?.(new Event("cancel"))
    restore()
  })

  function makeFile(text: string, name: string): File {
    const file = new File([text], name, { type: "application/json" })
    // jsdom's File.text() does not always return the constructor blob content
    // reliably — stub it so the test asserts on the toolbar's parsing branch
    // without relying on jsdom's Blob plumbing.
    Object.defineProperty(file, "text", {
      value: () => Promise.resolve(text),
    })
    return file
  }

  it("File install stages parsed manifests on success", async () => {
    render(<PluginPanelToolbar />)
    const { inputs, restore } = spyOnInputCreation()
    fireEvent.click(screen.getByText("fromFile"))
    await waitFor(() => expect(inputs.length).toBeGreaterThan(0))
    const input = inputs[inputs.length - 1]

    const file = makeFile(JSON.stringify({ id: "p1", name: "P1", version: "2.0.0" }), "p.json")
    Object.defineProperty(input, "files", { value: [file] })
    input.onchange?.(new Event("change"))

    await waitFor(() => expect(setImportStaging).toHaveBeenCalled())
    const [[arg]] = setImportStaging.mock.calls
    expect(arg.drafts).toHaveLength(1)
    expect(arg.drafts[0]).toMatchObject({
      id: "p1",
      name: "P1",
      version: "2.0.0",
    })
    expect(arg.parseErrors).toHaveLength(0)
    restore()
  })

  it("File install collects parse errors for non-JSON content", async () => {
    render(<PluginPanelToolbar />)
    const { inputs, restore } = spyOnInputCreation()
    fireEvent.click(screen.getByText("fromFile"))
    await waitFor(() => expect(inputs.length).toBeGreaterThan(0))
    const input = inputs[inputs.length - 1]
    const file = makeFile("not json {", "broken.json")
    Object.defineProperty(input, "files", { value: [file] })
    input.onchange?.(new Event("change"))

    await waitFor(() => expect(setImportStaging).toHaveBeenCalled())
    const [[arg]] = setImportStaging.mock.calls
    expect(arg.parseErrors.length).toBeGreaterThan(0)
    restore()
  })
})
