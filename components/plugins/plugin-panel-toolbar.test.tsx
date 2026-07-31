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

const canUseTauriInvokeMock = jest.fn()
jest.mock("@/lib/native/utils", () => ({
  canUseTauriInvoke: () => canUseTauriInvokeMock(),
}))

const wasmTriggerMock = jest.fn()
jest.mock("./dialogs/install-wasm-plugin-button", () => ({
  useInstallWasmFromLocal: () => ({
    trigger: wasmTriggerMock,
    busy: false,
    error: null,
    sheet: <div data-testid="wasm-grant-sheet-mounted" />,
  }),
}))

jest.mock("./dialogs/plugin-signed-install-from-url-dialog", () => ({
  PluginSignedInstallFromUrlDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean
    onOpenChange: (o: boolean) => void
  }) =>
    open ? (
      <div data-testid="signed-url-dialog">
        <button onClick={() => onOpenChange(false)}>close-signed-dialog</button>
      </div>
    ) : null,
}))

jest.mock("./dialogs/plugin-vsix-install-dialog", () => ({
  PluginVsixInstallDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="vsix-dialog" /> : null,
}))

jest.mock("./dialogs/plugin-wasm-from-git-dialog", () => ({
  PluginWasmFromGitDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="wasm-git-dialog" /> : null,
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
    disabled,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    className?: string
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
}))

// Stub the inner URL dialog — its behavior has its own dedicated test file.
jest.mock("./dialogs/plugin-install-from-url-dialog", () => ({
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
    wasmTriggerMock.mockClear()
    canUseTauriInvokeMock.mockReset()
    canUseTauriInvokeMock.mockReturnValue(true)
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

  describe("WASM bundle group (Tauri-only)", () => {
    it("renders the WASM group label and both items in Tauri mode", () => {
      canUseTauriInvokeMock.mockReturnValue(true)
      render(<PluginPanelToolbar />)
      expect(screen.getByText("groupWasm")).toBeInTheDocument()
      expect(screen.getByText("fromLocalWasm")).toBeInTheDocument()
      expect(screen.getByText("fromUrlSigned")).toBeInTheDocument()
    })

    it("hides the WASM group in web mode", () => {
      canUseTauriInvokeMock.mockReturnValue(false)
      render(<PluginPanelToolbar />)
      expect(screen.queryByText("groupWasm")).not.toBeInTheDocument()
      expect(screen.queryByText("fromLocalWasm")).not.toBeInTheDocument()
      expect(screen.queryByText("fromUrlSigned")).not.toBeInTheDocument()
    })

    it("From local .wasm/.zip menu item triggers the install flow", () => {
      canUseTauriInvokeMock.mockReturnValue(true)
      render(<PluginPanelToolbar />)
      fireEvent.click(screen.getByText("fromLocalWasm"))
      expect(wasmTriggerMock).toHaveBeenCalledTimes(1)
    })

    it("From signed URL menu item opens the signed URL dialog", async () => {
      canUseTauriInvokeMock.mockReturnValue(true)
      render(<PluginPanelToolbar />)
      fireEvent.click(screen.getByText("fromUrlSigned"))
      expect(await screen.findByTestId("signed-url-dialog")).toBeInTheDocument()
    })

    it("mounts the grant sheet exactly once when in Tauri mode", () => {
      canUseTauriInvokeMock.mockReturnValue(true)
      render(<PluginPanelToolbar />)
      expect(screen.getAllByTestId("wasm-grant-sheet-mounted")).toHaveLength(1)
    })

    it("From .vsix menu item opens the VSIX dialog", async () => {
      canUseTauriInvokeMock.mockReturnValue(true)
      render(<PluginPanelToolbar />)
      fireEvent.click(screen.getByText("fromVsix"))
      expect(await screen.findByTestId("vsix-dialog")).toBeInTheDocument()
    })

    it("From Git (WASM) menu item opens the wasm-from-git dialog", async () => {
      canUseTauriInvokeMock.mockReturnValue(true)
      render(<PluginPanelToolbar />)
      fireEvent.click(screen.getByText("fromWasmGit"))
      expect(await screen.findByTestId("wasm-git-dialog")).toBeInTheDocument()
    })

    it("hides the VSIX and Git (WASM) items in web mode", () => {
      canUseTauriInvokeMock.mockReturnValue(false)
      render(<PluginPanelToolbar />)
      expect(screen.queryByText("fromVsix")).not.toBeInTheDocument()
      expect(screen.queryByText("fromWasmGit")).not.toBeInTheDocument()
    })
  })

  it("renders manifest group label always", () => {
    render(<PluginPanelToolbar />)
    expect(screen.getByText("groupManifest")).toBeInTheDocument()
  })

  it("hides secondary action labels behind hidden lg:inline on narrow viewports", () => {
    render(<PluginPanelToolbar onCheckUpdates={() => {}} onSyncRegistry={() => {}} />)
    const checkLabel = screen.getByText("checkUpdates")
    const syncLabel = screen.getByText("syncRegistry")
    expect(checkLabel.className).toContain("hidden")
    expect(checkLabel.className).toContain("lg:inline")
    expect(syncLabel.className).toContain("hidden")
    expect(syncLabel.className).toContain("lg:inline")
  })
})
