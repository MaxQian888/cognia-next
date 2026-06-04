/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

type State = {
  loading: boolean
  error: string | null
  items: Array<{ id: string; source: string; sourceId: string; name: string; category: string }>
}
const ref: { current: { state: State; isSkillsMpEnabled: boolean; source: string } } = {
  current: {
    state: { loading: true, error: null, items: [] },
    isSkillsMpEnabled: false,
    source: "all",
  },
}
const install = jest.fn(async () => undefined)
const uninstall = jest.fn(async () => undefined)
const setQuery = jest.fn()
const refresh = jest.fn(async () => undefined)
const installedRef = { current: new Set<string>() }
jest.mock("@/hooks/skills", () => ({
  useSkillMarketplace: () => ({
    state: ref.current.state,
    isSkillsMpEnabled: ref.current.isSkillsMpEnabled,
    source: ref.current.source,
    setSource: jest.fn(),
    query: "",
    setQuery,
    refresh,
    installed: installedRef.current,
    installingId: null,
    install,
    uninstall,
  }),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

const mobileRef = { current: false }
jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => mobileRef.current,
}))

// The row + detail components aren't under test here — stub them.
jest.mock("./skill-marketplace-list-item", () => ({
  SkillMarketplaceListItem: ({
    item,
    onSelect,
  }: {
    item: { name: string }
    onSelect: (item: unknown) => void
  }) => (
    <div data-testid="mp-row" onClick={() => onSelect(item)}>
      {item.name}
    </div>
  ),
}))
jest.mock("./skill-marketplace-detail-content", () => ({
  SkillMarketplaceDetailContent: ({
    item,
    onInstall,
    onUninstall,
  }: {
    item: { name: string }
    onInstall: (item: unknown) => void
    onUninstall: (item: unknown) => void
  }) => (
    <div data-testid="mp-detail-content">
      {item.name}
      <button data-testid="content-install" onClick={() => onInstall(item)}>
        install
      </button>
      <button data-testid="content-uninstall" onClick={() => onUninstall(item)}>
        uninstall
      </button>
    </div>
  ),
}))
jest.mock("./skill-marketplace-detail", () => ({
  SkillMarketplaceDetail: () => <div data-testid="mp-detail-sheet" />,
}))
jest.mock("./skill-marketplace-empty", () => ({
  SkillMarketplaceEmpty: () => <div data-testid="mp-empty" />,
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { SkillMarketplace } from "./skill-marketplace"

const twoItems = [
  { id: "1", source: "registry", sourceId: "a", name: "Alpha", category: "custom" },
  { id: "2", source: "registry", sourceId: "b", name: "Beta", category: "custom" },
]

beforeEach(() => {
  jest.clearAllMocks()
  mobileRef.current = false
  installedRef.current = new Set<string>()
})

describe("SkillMarketplace", () => {
  it("shows a loading row with the localized label", () => {
    ref.current = {
      state: { loading: true, error: null, items: [] },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    // Both the left list and the right pane surface the loading state.
    expect(screen.getAllByText("loading").length).toBeGreaterThanOrEqual(1)
  })

  it("renders the empty teaser when SkillsMP is unconfigured and there are no items", () => {
    ref.current = {
      state: { loading: false, error: null, items: [] },
      isSkillsMpEnabled: false,
      source: "all",
    }
    render(<SkillMarketplace />)
    expect(screen.getByTestId("mp-empty")).toBeInTheDocument()
  })

  it("renders one row per item and auto-selects the first into the inline detail", () => {
    ref.current = {
      state: { loading: false, error: null, items: twoItems },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    expect(screen.getByTestId("skill-marketplace-list")).toBeInTheDocument()
    expect(screen.getAllByTestId("mp-row")).toHaveLength(2)
    expect(screen.getByTestId("mp-detail-content")).toHaveTextContent("Alpha")
    expect(screen.queryByTestId("mp-detail-sheet")).not.toBeInTheDocument()
  })

  it("shows the localized error message when loading fails", () => {
    ref.current = {
      state: { loading: false, error: "boom", items: [] },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    expect(screen.getByText('errorLoad:{"error":"boom"}')).toBeInTheDocument()
  })

  it("switches the inline detail when another row is clicked", () => {
    ref.current = {
      state: { loading: false, error: null, items: twoItems },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByText("Beta"))
    expect(screen.getByTestId("mp-detail-content")).toHaveTextContent("Beta")
  })

  it("shows the localized empty message when an enabled source has no items", () => {
    ref.current = {
      state: { loading: false, error: null, items: [] },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("writes the search query and triggers refresh", () => {
    ref.current = {
      state: { loading: false, error: null, items: twoItems },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    fireEvent.change(screen.getByPlaceholderText("searchPlaceholder"), {
      target: { value: "alp" },
    })
    expect(setQuery).toHaveBeenCalledWith("alp")
    fireEvent.click(screen.getByLabelText("refresh"))
    expect(refresh).toHaveBeenCalled()
  })

  it("installs the selected item and reports success", async () => {
    ref.current = {
      state: { loading: false, error: null, items: twoItems },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByTestId("content-install"))
    await waitFor(() => expect(install).toHaveBeenCalledWith(twoItems[0]))
    expect(toast.success).toHaveBeenCalled()
  })

  it("reports an error toast when installation fails", async () => {
    install.mockRejectedValueOnce(new Error("nope"))
    ref.current = {
      state: { loading: false, error: null, items: twoItems },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByTestId("content-install"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("nope"))
  })

  it("uninstalls the selected item and reports success", async () => {
    ref.current = {
      state: { loading: false, error: null, items: twoItems },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByTestId("content-uninstall"))
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith(twoItems[0]))
    expect(toast.success).toHaveBeenCalled()
  })

  it("reports an error toast when uninstall fails", async () => {
    uninstall.mockRejectedValueOnce(new Error("locked"))
    ref.current = {
      state: { loading: false, error: null, items: twoItems },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    fireEvent.click(screen.getByTestId("content-uninstall"))
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("locked"))
  })

  it("on mobile, selecting a row opens the Sheet instead of inline detail", () => {
    mobileRef.current = true
    ref.current = {
      state: { loading: false, error: null, items: twoItems },
      isSkillsMpEnabled: true,
      source: "all",
    }
    render(<SkillMarketplace />)
    // No auto-select on mobile.
    expect(screen.queryByTestId("mp-detail-sheet")).not.toBeInTheDocument()
    fireEvent.click(screen.getByText("Beta"))
    expect(screen.getByTestId("mp-detail-sheet")).toBeInTheDocument()
    expect(screen.queryByTestId("mp-detail-content")).not.toBeInTheDocument()
  })
})
