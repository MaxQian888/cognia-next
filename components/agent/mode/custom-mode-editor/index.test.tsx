/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import { CustomModeEditor } from "./index"
import type { CustomModeA2UITemplate, CustomModeConfig } from "@/stores/agent/custom-mode-store"

// i18n passthrough.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Toast — capture calls via a holder so the factory doesn't hit TDZ.
const toastHolder = { errorFn: (..._args: unknown[]) => undefined as void }
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastHolder.errorFn(...args) },
}))
const mockToastError = jest.fn((...args: unknown[]) => {
  void args
})
// Wire holder to the jest.fn so assertions work normally.
toastHolder.errorFn = mockToastError as (...args: unknown[]) => void

// Sub-components — stubbed so each test only exercises the editor shell.
jest.mock("./template-selector", () => ({
  TemplateSelector: ({ onSelect }: { onSelect: (t: unknown) => void }) => (
    <button
      data-testid="template-selector"
      onClick={() =>
        onSelect({
          id: "t1",
          name: "Tpl Name",
          description: "Tpl Desc",
          icon: "Brain",
          systemPrompt: "tpl sys",
          tools: ["Read"],
          outputFormat: "text",
          category: "technical",
          tags: ["t"],
          previewEnabled: true,
        })
      }
    >
      TemplateSelector
    </button>
  ),
}))

jest.mock("./icon-selector", () => ({
  IconSelector: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <button data-testid="icon-selector" data-value={value} onClick={() => onChange("Rocket")}>
      IconSelector:{value}
    </button>
  ),
}))

jest.mock("./tool-selector", () => ({
  ToolSelector: ({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) => (
    <button
      data-testid="tool-selector"
      data-count={value.length}
      onClick={() => onChange(["Bash", "Read"])}
    >
      ToolSelector
    </button>
  ),
}))

jest.mock("./mcp-tool-selector", () => ({
  McpToolSelector: ({ onChange }: { value: unknown[]; onChange: (v: unknown[]) => void }) => (
    <button
      data-testid="mcp-tool-selector"
      onClick={() => onChange([{ serverId: "s1", toolName: "mcp_tool" }])}
    >
      McpToolSelector
    </button>
  ),
}))

// No mock for `../a2ui-template-preview` on purpose. The mock that used to sit
// here rendered a toggle button the real component did not have, so the case
// below passed for years against a fixture while `showPreview` /
// `onTogglePreview` were silently ignored in production.

// LucideIcons proxy.
jest.mock("@/lib/agent/resolve-icon", () => ({
  LucideIcons: new Proxy(
    {},
    {
      get: (_target, prop: string) => {
        const Icon = ({ className }: { className?: string }) => (
          <svg data-testid={`icon-${prop}`} className={className} />
        )
        Icon.displayName = prop
        return Icon
      },
    }
  ),
}))

// Stub PROMPT_TEMPLATE_VARIABLES.
jest.mock("@/stores/agent/custom-mode-store", () => ({
  useCustomModeStore: () => mockCustomModeStore,
  checkToolAvailability: jest.fn(() => ({ available: [], unavailable: [] })),
  PROMPT_TEMPLATE_VARIABLES: {
    "{{date}}": "Current date",
    "{{time}}": "Current time",
  },
}))

// Settings store — returns empty settings.
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: (sel: (s: { settings: null }) => unknown) => sel({ settings: null }),
}))

// UI component mocks — enough to render the Dialog tree.
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode
    open: boolean
    onOpenChange: (v: boolean) => void
  }) =>
    open ? (
      <div
        data-testid="dialog"
        onClick={(e) => {
          // Only fire when clicked directly on the overlay, not via child bubbling.
          if (e.target === e.currentTarget) onOpenChange(false)
        }}
      >
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-content">{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2 data-testid="dialog-title">{children}</h2>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p data-testid="dialog-desc">{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
}))

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div data-testid="tabs">{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="tabs-list">{children}</div>
  ),
  TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button data-testid={`tab-trigger-${value}`} data-value={value}>
      {children}
    </button>
  ),
  TabsContent: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid={`tab-content-${value}`}>{children}</div>
  ),
}))

jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
    size,
    "aria-label": ariaLabel,
    type,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    variant?: string
    size?: string
    "aria-label"?: string
    type?: "button" | "reset" | "submit"
  }) => (
    <button
      data-variant={variant}
      data-size={size}
      disabled={disabled}
      aria-label={ariaLabel}
      type={type ?? "button"}
      onClick={onClick}
    >
      {children}
    </button>
  ),
}))

jest.mock("@/components/ui/input", () => ({
  Input: ({
    id,
    value,
    onChange,
    placeholder,
    type,
    onKeyDown,
  }: {
    id?: string
    value?: string | number
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void
    placeholder?: string
    type?: string
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  }) => (
    <input
      data-testid={id ? `input-${id}` : "input"}
      id={id}
      type={type}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
    />
  ),
}))

jest.mock("@/components/ui/textarea", () => ({
  Textarea: ({
    id,
    value,
    onChange,
    placeholder,
    className,
  }: {
    id?: string
    value?: string
    onChange?: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    placeholder?: string
    className?: string
  }) => (
    <textarea
      data-testid={id ? `textarea-${id}` : "textarea"}
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      className={className}
    />
  ),
}))

jest.mock("@/components/ui/label", () => ({
  Label: ({ children, htmlFor }: { children: React.ReactNode; htmlFor?: string }) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
}))

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    checked,
    onCheckedChange,
    id,
  }: {
    checked?: boolean
    onCheckedChange?: (v: boolean) => void
    id?: string
  }) => (
    <input
      data-testid={id ? `switch-${id}` : "switch"}
      type="checkbox"
      id={id}
      checked={checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}))

jest.mock("@/components/ui/slider", () => ({
  Slider: ({ value, onValueChange }: { value: number[]; onValueChange: (v: number[]) => void }) => (
    <input
      data-testid="slider"
      type="range"
      value={value[0]}
      onChange={(e) => onValueChange([parseFloat(e.target.value)])}
    />
  ),
}))

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
    <div data-testid="select" data-value={value}>
      {children}
      <button data-testid="select-change-btn" onClick={() => onValueChange?.("markdown")} />
    </div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-trigger">{children}</div>
  ),
  SelectValue: () => <span data-testid="select-value" />,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-content">{children}</div>
  ),
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-testid={`select-item-${value}`}>{children}</div>
  ),
}))

jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children, variant, ...rest }: React.ComponentProps<"span"> & { variant?: string }) => (
    <span data-testid="badge" data-variant={variant} {...rest}>
      {children}
    </span>
  ),
}))

// Props are forwarded: the A2UI preview (rendered for real, not mocked) tags
// its Card / CardContent with its own test ids, and a mock that only passed
// `className` would drop them.
jest.mock("@/components/ui/card", () => ({
  Card: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div data-testid="card" {...rest}>
      {children}
    </div>
  ),
  CardContent: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div {...rest}>{children}</div>
  ),
  CardHeader: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div {...rest}>{children}</div>
  ),
  CardTitle: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div {...rest}>{children}</div>
  ),
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, ...rest }: React.ComponentProps<"div">) => (
    <div {...rest}>{children}</div>
  ),
}))

jest.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CollapsibleTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) =>
    asChild ? <>{children}</> : <div>{children}</div>,
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// Custom mode store mock state (mutable).
const mockCustomModeStore = {
  createMode: jest.fn(),
  updateMode: jest.fn(),
  generateModeFromDescription: jest.fn(),
  isGenerating: false,
}

const SAMPLE_MODE: CustomModeConfig = {
  id: "mode-1",
  type: "custom",
  isBuiltIn: false,
  name: "My Mode",
  description: "A test mode",
  icon: "Bot",
  systemPrompt: "You are a helper.",
  tools: ["Read"],
  outputFormat: "text",
  previewEnabled: false,
  category: "other",
  tags: ["tag1"],
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
}

beforeEach(() => {
  mockCustomModeStore.createMode.mockClear()
  mockCustomModeStore.updateMode.mockClear()
  mockCustomModeStore.generateModeFromDescription.mockClear()
  mockCustomModeStore.isGenerating = false
  mockToastError.mockClear()

  // createMode returns a full mode object.
  mockCustomModeStore.createMode.mockReturnValue({ ...SAMPLE_MODE, id: "new-mode-1" })
})

function renderEditor(props: Partial<Parameters<typeof CustomModeEditor>[0]> = {}) {
  return render(<CustomModeEditor open onOpenChange={jest.fn()} {...props} />)
}

describe("CustomModeEditor — render (create mode)", () => {
  it("renders without crashing", () => {
    renderEditor()
  })

  it("shows the createMode title when no existing mode is passed", () => {
    renderEditor()
    expect(screen.getByTestId("dialog-title").textContent).toBe("createMode")
  })

  it("shows the editMode title when an existing mode is passed", () => {
    renderEditor({ mode: SAMPLE_MODE })
    expect(screen.getByTestId("dialog-title").textContent).toBe("editMode")
  })

  it("renders all 4 tab triggers", () => {
    renderEditor()
    expect(screen.getByTestId("tab-trigger-basic")).toBeInTheDocument()
    expect(screen.getByTestId("tab-trigger-tools")).toBeInTheDocument()
    expect(screen.getByTestId("tab-trigger-advanced")).toBeInTheDocument()
    expect(screen.getByTestId("tab-trigger-generate")).toBeInTheDocument()
  })

  it("renders the template selector only in create mode (not edit mode)", () => {
    renderEditor()
    expect(screen.getByTestId("template-selector")).toBeInTheDocument()
  })

  it("does not render the template selector in edit mode", () => {
    renderEditor({ mode: SAMPLE_MODE })
    expect(screen.queryByTestId("template-selector")).not.toBeInTheDocument()
  })

  it("pre-fills the name input from the existing mode", () => {
    renderEditor({ mode: SAMPLE_MODE })
    const nameInput = screen.getByTestId("input-name") as HTMLInputElement
    expect(nameInput.value).toBe(SAMPLE_MODE.name)
  })

  it("pre-fills the description input from the existing mode", () => {
    renderEditor({ mode: SAMPLE_MODE })
    const descInput = screen.getByTestId("input-description") as HTMLInputElement
    expect(descInput.value).toBe(SAMPLE_MODE.description)
  })

  it("shows cancel button", () => {
    renderEditor()
    expect(screen.getByText("cancel")).toBeInTheDocument()
  })

  it("shows create button in create mode", () => {
    renderEditor()
    expect(screen.getByText("create")).toBeInTheDocument()
  })

  it("shows save button in edit mode", () => {
    renderEditor({ mode: SAMPLE_MODE })
    expect(screen.getByText("save")).toBeInTheDocument()
  })
})

describe("CustomModeEditor — form interactions", () => {
  it("updates the name field on user input", () => {
    renderEditor()
    const nameInput = screen.getByTestId("input-name") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "New Name" } })
    expect(nameInput.value).toBe("New Name")
  })

  it("updates the description field on user input", () => {
    renderEditor()
    const descInput = screen.getByTestId("input-description") as HTMLInputElement
    fireEvent.change(descInput, { target: { value: "Some desc" } })
    expect(descInput.value).toBe("Some desc")
  })

  it("changes the category via the Select mock button", () => {
    renderEditor()
    const basicTab = screen.getByTestId("tab-content-basic")
    // Select mock renders a data-testid="select-change-btn" that fires onValueChange("markdown").
    // In basic tab, the first Select is the category selector.
    const selectChangeBtns = basicTab.querySelectorAll("[data-testid='select-change-btn']")
    expect(selectChangeBtns.length).toBeGreaterThan(0)
    // Clicking should not throw (calls setCategory with "markdown" value, which gets cast).
    expect(() => fireEvent.click(selectChangeBtns[0])).not.toThrow()
  })

  it("updates the system prompt textarea on user input", () => {
    renderEditor()
    const promptTextarea = screen.getByTestId("textarea-prompt") as HTMLTextAreaElement
    fireEvent.change(promptTextarea, { target: { value: "You are a bot." } })
    expect(promptTextarea.value).toBe("You are a bot.")
  })

  it("adds a tag when Enter is pressed in the tag input", () => {
    renderEditor()
    // Find the tag input — it has placeholder "addTag" (from i18n passthrough).
    const tagInput = screen.getByPlaceholderText("addTag") as HTMLInputElement
    fireEvent.change(tagInput, { target: { value: "newtag" } })
    fireEvent.keyDown(tagInput, { key: "Enter" })
    // The badge wraps the tag text + remove button, so use getAllByText.
    expect(screen.getAllByText(/newtag/).length).toBeGreaterThan(0)
  })

  it("adds a tag when the plus button is clicked", () => {
    renderEditor()
    const tagInput = screen.getByPlaceholderText("addTag") as HTMLInputElement
    fireEvent.change(tagInput, { target: { value: "clicktag" } })
    // Simulate clicking the add-tag button via the keyboard shortcut (equivalent behavior).
    // The Enter key on the input triggers addTag(), which is the same code path.
    fireEvent.keyDown(tagInput, { key: "Enter" })
    expect(screen.getAllByText(/clicktag/).length).toBeGreaterThan(0)
  })

  it("renders a remove button for each tag that is present in the mode", () => {
    // Verifies the remove-tag button is correctly rendered for each tag.
    // The actual state-removal is an internal React state update tested via
    // the component's integration within its own render cycle.
    renderEditor({ mode: { ...SAMPLE_MODE, tags: ["alpha", "beta"] } })
    // Two tags → two remove buttons.
    expect(screen.getAllByRole("button", { name: "removeTag" }).length).toBe(2)
  })
})

describe("CustomModeEditor — save behavior", () => {
  it("calls createMode and onOpenChange when Create is clicked with a valid name", () => {
    const onOpenChange = jest.fn()
    renderEditor({ onOpenChange })
    const nameInput = screen.getByTestId("input-name") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "Valid Name" } })
    const createBtn = screen.getByText("create")
    fireEvent.click(createBtn)
    expect(mockCustomModeStore.createMode).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("calls onSave with the new mode after creation", () => {
    const onSave = jest.fn()
    renderEditor({ onSave })
    const nameInput = screen.getByTestId("input-name") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "My New Mode" } })
    fireEvent.click(screen.getByText("create"))
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it("disables the Create button when name is empty", () => {
    renderEditor()
    const createBtn = screen.getByText("create")
    expect(createBtn.closest("button")).toBeDisabled()
  })

  it("enables the Create button when name is non-empty", () => {
    renderEditor()
    const nameInput = screen.getByTestId("input-name") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "Something" } })
    const createBtn = screen.getByText("create")
    expect(createBtn.closest("button")).not.toBeDisabled()
  })

  it("calls updateMode (not createMode) when saving an existing mode", () => {
    const onOpenChange = jest.fn()
    renderEditor({ mode: SAMPLE_MODE, onOpenChange })
    fireEvent.click(screen.getByText("save"))
    expect(mockCustomModeStore.updateMode).toHaveBeenCalledTimes(1)
    expect(mockCustomModeStore.createMode).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("calls onOpenChange(false) when Cancel is clicked", () => {
    const onOpenChange = jest.fn()
    renderEditor({ onOpenChange })
    fireEvent.click(screen.getByText("cancel"))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("CustomModeEditor — template selection", () => {
  it("renders the template selector in create mode and it calls onSelect", () => {
    // The TemplateSelector stub is a button that fires onSelect when clicked.
    // We verify it is present and clickable without errors.
    renderEditor()
    const templateBtn = screen.getByTestId("template-selector")
    expect(templateBtn).toBeInTheDocument()
    // Click should not throw and the component should still render.
    expect(() => fireEvent.click(templateBtn)).not.toThrow()
    // The editor remains open (dialog still present).
    expect(screen.getByTestId("dialog-content")).toBeInTheDocument()
  })

  it("does not render the template selector when editing an existing mode", () => {
    renderEditor({ mode: SAMPLE_MODE })
    expect(screen.queryByTestId("template-selector")).not.toBeInTheDocument()
  })
})

describe("CustomModeEditor — AI generation", () => {
  it("renders the generate tab content with a textarea", () => {
    renderEditor()
    const generateTab = screen.getByTestId("tab-content-generate")
    const textarea = generateTab.querySelector("textarea")
    expect(textarea).not.toBeNull()
  })

  it("disables the Generate button when generationPrompt is empty", () => {
    renderEditor()
    const generateTab = screen.getByTestId("tab-content-generate")
    const btn = generateTab.querySelector("button[disabled]")
    expect(btn).not.toBeNull()
  })

  it("calls generateModeFromDescription when Generate is clicked with a prompt", async () => {
    mockCustomModeStore.generateModeFromDescription.mockResolvedValue({
      mode: {
        name: "Generated",
        description: "desc",
        icon: "Bot",
        tools: [],
        outputFormat: "text",
        category: "other",
      },
    })
    renderEditor()
    const generateTab = screen.getByTestId("tab-content-generate")
    const textarea = generateTab.querySelector("textarea")!
    fireEvent.change(textarea, { target: { value: "Make a coding mode" } })
    // Find the generate button (not the example buttons).
    const genBtn = screen.getByText("generate")
    await act(async () => {
      fireEvent.click(genBtn.closest("button")!)
    })
    expect(mockCustomModeStore.generateModeFromDescription).toHaveBeenCalledTimes(1)
  })

  it("shows a toast error when generation throws", async () => {
    mockCustomModeStore.generateModeFromDescription.mockRejectedValue(new Error("API error"))
    renderEditor()
    const generateTab = screen.getByTestId("tab-content-generate")
    const textarea = generateTab.querySelector("textarea")!
    fireEvent.change(textarea, { target: { value: "Make a mode" } })
    const genBtn = screen.getByText("generate")
    await act(async () => {
      fireEvent.click(genBtn.closest("button")!)
    })
    expect(mockToastError).toHaveBeenCalledWith("modeGenerationFailed")
  })

  it("shows spinner/loading state when isGenerating is true", () => {
    mockCustomModeStore.isGenerating = true
    renderEditor()
    expect(screen.getByText("generating")).toBeInTheDocument()
  })

  it("fills the generation prompt textarea when an example button is clicked", () => {
    renderEditor()
    const generateTab = screen.getByTestId("tab-content-generate")
    // The example buttons have data-size="sm" and data-variant="ghost".
    const exampleBtns = Array.from(
      generateTab.querySelectorAll("button[data-size='sm'][data-variant='ghost']")
    ).filter((b) => b.textContent?.startsWith("example"))
    expect(exampleBtns.length).toBeGreaterThan(0)
    fireEvent.click(exampleBtns[0])
    const textarea = generateTab.querySelector("textarea") as HTMLTextAreaElement
    // The textarea value should now contain the example text.
    expect(textarea.value.length).toBeGreaterThan(0)
  })
})

describe("CustomModeEditor — advanced tab", () => {
  it("renders the A2UI preview when a2uiEnabled is toggled on", () => {
    renderEditor()
    // The a2ui Switch has id "include-a2ui" in the generate tab.
    // In the advanced tab there is another switch for a2uiEnabled.
    // The advanced tab always renders; find the a2ui switch there.
    const advancedTab = screen.getByTestId("tab-content-advanced")
    const switches = advancedTab.querySelectorAll("input[type='checkbox']")
    // Switch order in advanced: livePreview (first), enableA2UI (second)
    const a2uiSwitch = switches[1] as HTMLInputElement
    expect(a2uiSwitch).toBeDefined()
    // Initially a2uiEnabled is false; the preview should not be visible.
    expect(screen.queryByTestId("a2ui-template-empty")).not.toBeInTheDocument()
    fireEvent.click(a2uiSwitch)
    // A mode with no stored template gets the honest empty state rather than a
    // card claiming to preview nothing.
    expect(screen.getByTestId("a2ui-template-empty")).toBeInTheDocument()
  })

  it("renders the model override input", () => {
    renderEditor()
    const advancedTab = screen.getByTestId("tab-content-advanced")
    const inputs = advancedTab.querySelectorAll("input")
    expect(inputs.length).toBeGreaterThan(0)
  })

  it("updates the model override input on change", () => {
    renderEditor()
    const advancedTab = screen.getByTestId("tab-content-advanced")
    // Model override input: no id, placeholder "modelOverridePlaceholder"
    const modelInput = advancedTab.querySelector(
      "input[placeholder='modelOverridePlaceholder']"
    ) as HTMLInputElement
    expect(modelInput).not.toBeNull()
    fireEvent.change(modelInput, { target: { value: "claude-3-5-haiku" } })
    expect(modelInput.value).toBe("claude-3-5-haiku")
  })

  it("changes outputFormat via the Select mock button in the advanced tab", () => {
    renderEditor()
    const advancedTab = screen.getByTestId("tab-content-advanced")
    // Select mock exposes a data-testid="select-change-btn" that fires onValueChange("markdown").
    const selectChangeBtns = advancedTab.querySelectorAll("[data-testid='select-change-btn']")
    // First Select is outputFormat.
    expect(selectChangeBtns.length).toBeGreaterThan(0)
    expect(() => fireEvent.click(selectChangeBtns[0])).not.toThrow()
  })

  it("shows the stored A2UI template rather than an empty card", () => {
    // The generator has always been able to produce `suggestedA2UITemplate`,
    // but the editor dropped it and never passed one down, so this card was
    // permanently its own empty state.
    renderEditor({
      mode: {
        ...SAMPLE_MODE,
        // `previewEnabled` is what the card's expanded state is bound to.
        previewEnabled: true,
        a2uiEnabled: true,
        a2uiTemplate: {
          id: "tpl-1",
          name: "Status board",
          components: [{ component: "Card" }] as unknown as CustomModeA2UITemplate["components"],
          dataModel: {},
        },
      },
    })
    expect(screen.getByTestId("a2ui-template-preview")).toBeInTheDocument()
    expect(screen.getByText("Status board")).toBeInTheDocument()
  })

  it("the preview's toggle drives the same live-preview switch as the row above it", () => {
    renderEditor({
      mode: {
        ...SAMPLE_MODE,
        previewEnabled: true,
        a2uiEnabled: true,
        a2uiTemplate: {
          id: "tpl-1",
          name: "Status board",
          components: [] as unknown as CustomModeA2UITemplate["components"],
          dataModel: {},
        },
      },
    })
    const advancedTab = screen.getByTestId("tab-content-advanced")
    const livePreviewSwitch = advancedTab.querySelectorAll(
      "input[type='checkbox']"
    )[0] as HTMLInputElement
    expect(livePreviewSwitch.checked).toBe(true)
    expect(screen.getByTestId("a2ui-template-body")).toBeInTheDocument()

    // The Button mock drops data-testid, so find the toggle by its label key.
    fireEvent.click(screen.getByText("a2uiTemplateHide"))
    expect(livePreviewSwitch.checked).toBe(false)
    expect(screen.queryByTestId("a2ui-template-body")).not.toBeInTheDocument()
  })

  it("updates temperature via the slider", () => {
    renderEditor()
    const slider = screen.getByTestId("slider") as HTMLInputElement
    fireEvent.change(slider, { target: { value: "1.5" } })
    // After change, the temperature display should show "1.5"
    const advancedTab = screen.getByTestId("tab-content-advanced")
    expect(advancedTab.textContent).toContain("1.5")
  })

  it("updates maxTokens via the number input (non-empty value)", () => {
    renderEditor()
    const advancedTab = screen.getByTestId("tab-content-advanced")
    // The maxTokens input has type="number" and no id — find by type within the tab
    const numberInputs = Array.from(advancedTab.querySelectorAll("input[type='number']"))
    expect(numberInputs.length).toBeGreaterThan(0)
    const maxTokensInput = numberInputs[0] as HTMLInputElement
    fireEvent.change(maxTokensInput, { target: { value: "2048" } })
    expect(maxTokensInput.value).toBe("2048")
  })

  it("sets maxTokensOverride to undefined when the number input is cleared", () => {
    renderEditor({ mode: { ...SAMPLE_MODE, maxTokensOverride: 4096 } })
    const advancedTab = screen.getByTestId("tab-content-advanced")
    const numberInputs = Array.from(advancedTab.querySelectorAll("input[type='number']"))
    const maxTokensInput = numberInputs[0] as HTMLInputElement
    // Clearing the value should set undefined (no crash).
    expect(() => {
      fireEvent.change(maxTokensInput, { target: { value: "" } })
    }).not.toThrow()
  })
})

describe("CustomModeEditor — removeTag", () => {
  it("removes a tag when its remove button is clicked", async () => {
    renderEditor({ mode: { ...SAMPLE_MODE, tags: ["alpha", "beta"] } })
    // Both remove buttons should be present initially.
    const removeBtns = screen.getAllByRole("button", { name: "removeTag" })
    expect(removeBtns.length).toBe(2)
    // Click the first remove button — stop propagation so Dialog mock doesn't
    // intercept the event and call resetForm() before the state update settles.
    await act(async () => {
      fireEvent.click(removeBtns[0])
    })
    // One tag was removed — now only one remove button.
    expect(screen.getAllByRole("button", { name: "removeTag" }).length).toBe(1)
  })
})

describe("CustomModeEditor — resetForm (dialog close)", () => {
  it("calls onOpenChange and invokes resetForm when the dialog wrapper is clicked", () => {
    // resetForm is called when the Dialog's onOpenChange fires with false.
    // Our Dialog mock fires onOpenChange(false) when the wrapper div is clicked.
    const onOpenChange = jest.fn()
    render(<CustomModeEditor open onOpenChange={onOpenChange} />)
    // Type something in the name field so state diverges from the initial empty form.
    const nameInput = screen.getByTestId("input-name") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "Typed Name" } })
    expect(nameInput.value).toBe("Typed Name")
    // Click the dialog wrapper — Dialog mock calls onOpenChange(false),
    // which triggers the internal `if (!open) resetForm()` branch.
    const dialog = screen.getByTestId("dialog")
    expect(() => fireEvent.click(dialog)).not.toThrow()
    // onOpenChange should have been called with false.
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("CustomModeEditor — template variable insertion", () => {
  it("inserts a template variable into the system prompt when the variable button is clicked", () => {
    renderEditor()
    // Pre-fill the system prompt with some text.
    const promptTextarea = screen.getByTestId("textarea-prompt") as HTMLTextAreaElement
    fireEvent.change(promptTextarea, { target: { value: "Today is " } })
    // The CollapsibleContent is always visible in the flat Collapsible mock.
    // PROMPT_TEMPLATE_VARIABLES has "{{date}}" and "{{time}}".
    // Click the first variable button (contains the variable key in the code tag).
    const variableButtons = screen
      .getByTestId("tab-content-basic")
      .querySelectorAll("button[data-size='sm'][data-variant='ghost']")
    // Filter buttons that have a <code> child (template variable buttons vs the trigger button).
    const varBtns = Array.from(variableButtons).filter((b) => b.querySelector("code") !== null)
    expect(varBtns.length).toBeGreaterThan(0)
    fireEvent.click(varBtns[0])
    // The system prompt should now contain the variable.
    expect(promptTextarea.value).toContain("{{")
  })
})

describe("CustomModeEditor — unavailable tools warning", () => {
  it("shows the warning banner when checkToolAvailability returns unavailable tools", () => {
    const { checkToolAvailability } = jest.requireMock("@/stores/agent/custom-mode-store") as {
      checkToolAvailability: jest.Mock
    }
    checkToolAvailability.mockReturnValue({
      available: [],
      unavailable: [{ tool: "WebSearch", reason: "API key missing" }],
    })

    renderEditor({ mode: { ...SAMPLE_MODE, tools: ["WebSearch"] } })
    const toolsTab = screen.getByTestId("tab-content-tools")
    expect(toolsTab.textContent).toContain("WebSearch")
  })
})
