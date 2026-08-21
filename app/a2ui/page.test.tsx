import React from "react"
import { readFileSync } from "node:fs"
import path from "node:path"
import { act, fireEvent, render as baseRender, screen, within } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { A2UIAppInstance } from "@/hooks/a2ui/use-app-builder"

const replace = jest.fn()
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ replace, push: jest.fn() }),
}))

const appBuilder = {
  createCustomApp: jest.fn(),
  createFromTemplate: jest.fn(),
  deleteApp: jest.fn(async () => true),
  downloadApp: jest.fn(() => true),
  duplicateApp: jest.fn(),
  exportAllApps: jest.fn(() => "{}"),
  exportApp: jest.fn(() => "{}"),
  getAllApps: jest.fn((): A2UIAppInstance[] => []),
  getTemplate: jest.fn(() => undefined),
  getTemplatesByCategory: jest.fn(() => []),
  hydratePersistedApps: jest.fn(async () => undefined),
  importAppFromFile: jest.fn(),
  searchTemplates: jest.fn(() => []),
  templates: [] as { id: string; name: string }[],
  toggleFavorite: jest.fn(async () => true),
}

jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: () => appBuilder,
}))
jest.mock("@/components/a2ui/a2ui-surface", () => ({
  A2UIInlineSurface: () => <div data-testid="surface" />,
}))
jest.mock("@/components/a2ui/app-detail-dialog", () => ({ AppDetailDialog: () => null }))
jest.mock("@/components/a2ui/delete-confirm-dialog", () => ({
  DeleteConfirmDialog: () => null,
}))
jest.mock("@/components/a2ui/quick-app-builder/template-card", () => ({
  TemplateCard: ({ template }: { template: { name: string } }) => <div>{template.name}</div>,
}))
jest.mock("@/components/a2ui/workspace/a2ui-workspace", () => ({
  A2UIWorkspace: () => <div data-testid="workspace" />,
}))

const generateA2UIApp = jest.fn(async () => ({
  surfaceId: "s1",
  components: [],
  dataModel: {},
  rootId: "root",
  title: "Generated",
  usedFallback: false,
}))
jest.mock("@/lib/a2ui/ai-generate", () => ({
  generateA2UIApp: (...args: unknown[]) => generateA2UIApp(...(args as [])),
}))

// The options row has its own suite (it binds CharacterPicker + ModelSelect);
// here it stands in as the seam so the page's own job — persisting the choice
// and forwarding it to the generation call — is what gets asserted.
jest.mock("@/components/a2ui/generation-options", () => ({
  A2UIGenerationOptions: ({
    value,
    onChange,
  }: {
    value: Record<string, string | undefined>
    onChange: (next: Record<string, string | undefined>) => void
  }) => (
    <button
      data-testid="stub-generation-options"
      data-value={JSON.stringify(value)}
      onClick={() => onChange({ characterId: "char_9", model: "gpt-5", provider: "openai" })}
    >
      options
    </button>
  ),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

import A2UIPage from "./page"

// The page renders `FeaturePageHeader` and a tooltipped view-mode toggle. In
// the app both live under the root layout's provider; the bare render needs
// its own, same as `sites-console.test.tsx` / `feature-page-header.test.tsx`.
const render = (ui: React.ReactElement) => baseRender(<TooltipProvider>{ui}</TooltipProvider>)

function makeApp(overrides: Partial<A2UIAppInstance> = {}): A2UIAppInstance {
  return {
    id: "app-1",
    templateId: "tpl-1",
    name: "Expense Tracker",
    createdAt: 1,
    lastModified: 2,
    ...overrides,
  }
}

describe("A2UIPage", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.localStorage.clear()
    appBuilder.getAllApps.mockReturnValue([])
    appBuilder.templates = []
  })

  it("renders localized quick prompts and uses the selected prompt as generation input", () => {
    render(<A2UIPage />)
    fireEvent.click(screen.getByRole("button", { name: "Pomodoro Timer" }))
    expect(screen.getByPlaceholderText("e.g. Make a pomodoro timer...")).toHaveValue(
      "Pomodoro Timer"
    )
  })

  it("keeps the quick prompt keys complete in both locale catalogs", () => {
    expect(enMessages.a2ui.quickPromptPomodoro).toBe("Pomodoro Timer")
    expect(enMessages.a2ui.quickPromptConverter).toBe("Unit Converter")
    expect(zhMessages.a2ui.quickPromptPomodoro).toBe("番茄钟")
    expect(zhMessages.a2ui.quickPromptConverter).toBe("单位换算器")
  })

  it("localizes the header actions added by the hub redesign", () => {
    expect(enMessages.a2ui.back).toBe("Back")
    expect(enMessages.a2ui.moreActions).toBe("More actions")
    expect(zhMessages.a2ui.back).toBe("返回")
    expect(zhMessages.a2ui.moreActions).toBe("更多操作")
  })

  it("keeps the generate button as the only enabled primary until a prompt is typed", () => {
    render(<A2UIPage />)
    const generate = screen.getByRole("button", { name: enMessages.a2ui.aiGenerate })
    expect(generate).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText("e.g. Make a pomodoro timer..."), {
      target: { value: "a habit tracker" },
    })
    expect(generate).toBeEnabled()
  })

  it("shows the empty state with a call to action when no apps exist", () => {
    render(<A2UIPage />)
    expect(screen.getByText(enMessages.a2ui.noAppsYet)).toBeInTheDocument()
    expect(screen.getByText(enMessages.a2ui.createFirstApp)).toBeInTheDocument()
    // The category / favorites filter row is pointless with an empty library.
    expect(
      screen.queryByRole("button", { name: enMessages.a2ui.favoritesFilter })
    ).not.toBeInTheDocument()
  })

  it("renders one card per app and badges only the most recent one", () => {
    appBuilder.getAllApps.mockReturnValue([
      makeApp({ id: "app-1", name: "Newest", lastModified: 20 }),
      makeApp({ id: "app-2", name: "Older", lastModified: 10 }),
    ])
    render(<A2UIPage />)

    const cards = screen.getAllByTestId("a2ui-app-card")
    expect(cards).toHaveLength(2)
    expect(within(cards[0]).getByText("Newest")).toBeInTheDocument()
    expect(within(cards[0]).getByText(enMessages.a2ui.recentlyEdited)).toBeInTheDocument()
    expect(within(cards[1]).queryByText(enMessages.a2ui.recentlyEdited)).not.toBeInTheDocument()
  })

  it("toggles a favorite from the card without opening the workspace", async () => {
    appBuilder.getAllApps.mockReturnValue([makeApp()])
    render(<A2UIPage />)

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: enMessages.a2ui.favorite }))
    })
    expect(appBuilder.toggleFavorite).toHaveBeenCalledWith("app-1")
  })

  it("filters the library down to favorites", () => {
    appBuilder.getAllApps.mockReturnValue([
      makeApp({ id: "app-1", name: "Starred", isFavorite: true }),
      makeApp({ id: "app-2", name: "Plain" }),
    ])
    render(<A2UIPage />)

    expect(screen.getAllByTestId("a2ui-app-card")).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: enMessages.a2ui.favoritesFilter }))
    const cards = screen.getAllByTestId("a2ui-app-card")
    expect(cards).toHaveLength(1)
    expect(within(cards[0]).getByText("Starred")).toBeInTheDocument()
  })

  it("localizes the layout controls added by the scroll pass", () => {
    for (const messages of [enMessages, zhMessages]) {
      expect(messages.a2ui.scrollToTop).toBeTruthy()
      expect(messages.a2ui.showAll).toBeTruthy()
      expect(messages.a2ui.showLess).toBeTruthy()
    }
  })

  it("pins the library toolbar so search and filters survive a long list", () => {
    appBuilder.getAllApps.mockReturnValue([makeApp()])
    render(<A2UIPage />)
    const toolbar = screen.getByTestId("a2ui-library-toolbar")
    expect(toolbar.className).toContain("sticky")
    // Not pinned until the sentinel scrolls out; the divider stays transparent.
    expect(toolbar).toHaveAttribute("data-pinned", "false")
    expect(toolbar).toContainElement(screen.getByPlaceholderText(enMessages.a2ui.searchPlaceholder))
    expect(toolbar).toContainElement(
      screen.getByRole("button", { name: enMessages.a2ui.favoritesFilter })
    )
  })

  it("keeps the back-to-top control out of the way until the page is scrolled", () => {
    render(<A2UIPage />)
    // `pointer-events-none` alone is not a signal — the Button base already
    // carries it under `disabled:` and `[&_svg]:` prefixes.
    expect(screen.getByTestId("a2ui-back-to-top").className.split(" ")).toContain("opacity-0")

    fireEvent.scroll(screen.getByTestId("a2ui-hub-scroll"), {
      target: { scrollTop: 900 },
    })
    expect(screen.getByTestId("a2ui-back-to-top").className.split(" ")).toContain("opacity-100")
  })

  it("caps the template library at two rows until it is expanded", () => {
    appBuilder.templates = Array.from({ length: 9 }, (_, i) => ({
      id: `tpl-${i}`,
      name: `Template ${i}`,
    }))
    render(<A2UIPage />)

    expect(screen.getByText("Template 5")).toBeInTheDocument()
    expect(screen.queryByText("Template 6")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: new RegExp(enMessages.a2ui.showAll, "i") }))
    expect(screen.getByText("Template 8")).toBeInTheDocument()
  })

  it("renders list mode as one divided surface rather than floating cards", () => {
    appBuilder.getAllApps.mockReturnValue([
      makeApp({ id: "app-1", name: "First" }),
      makeApp({ id: "app-2", name: "Second" }),
    ])
    render(<A2UIPage />)

    fireEvent.click(screen.getByRole("button", { name: enMessages.a2ui.listView }))
    const rows = screen.getAllByTestId("a2ui-app-card")
    expect(rows).toHaveLength(2)
    // One shared container, so only the rows after the first draw a divider.
    expect(rows[0].parentElement).toBe(rows[1].parentElement)
    expect(rows[0].className).not.toContain("border-t")
    expect(rows[1].className).toContain("border-t")
  })

  it("mounts the generation options inside the composer", () => {
    render(<A2UIPage />)
    expect(screen.getByTestId("stub-generation-options")).toBeInTheDocument()
  })

  it("remembers the chosen agent and model across mounts", () => {
    const first = render(<A2UIPage />)
    fireEvent.click(screen.getByTestId("stub-generation-options"))
    first.unmount()

    render(<A2UIPage />)
    expect(screen.getByTestId("stub-generation-options")).toHaveAttribute(
      "data-value",
      JSON.stringify({ characterId: "char_9", model: "gpt-5", provider: "openai" })
    )
  })

  it("forwards the chosen agent and model to the generation call", async () => {
    render(<A2UIPage />)
    fireEvent.click(screen.getByTestId("stub-generation-options"))
    fireEvent.change(screen.getByPlaceholderText("e.g. Make a pomodoro timer..."), {
      target: { value: "a habit tracker" },
    })

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: enMessages.a2ui.aiGenerate }))
    })

    // These are the exact fields `resolveSendOptions` reads off a session, so
    // forwarding them is what makes the options real rather than decorative.
    expect(generateA2UIApp).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: "a habit tracker",
        mode: "create",
        characterId: "char_9",
        model: "gpt-5",
        providerOverride: "openai",
      })
    )
  })

  // The hub previously mixed rounded-3xl shells, a rounded-[28px] aside and
  // rounded-2xl panels with token-scale cards and controls, which is what made
  // the page read as a pile of mismatched boxes. Radii here must come from the
  // --radius-* scale only; an arbitrary value is a design regression.
  it("uses only design-token radii", () => {
    const source = readFileSync(path.join(process.cwd(), "app/a2ui/page.tsx"), "utf8")
    // Comments are allowed to name the removed values, the markup is not.
    const markup = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    const offScale = markup.match(/rounded-(?:\[[^\]]+\]|2xl|3xl|4xl)/g)
    expect(offScale).toBeNull()
  })
})
