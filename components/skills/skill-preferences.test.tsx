/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("@/hooks/skills", () => ({
  useSkillPanelPrefs: jest.fn(),
}))

jest.mock("@/stores/settings", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { create } = require("zustand")
  const useSettingsStore = create(() => ({ setSkillPanelPrefs: jest.fn() }))
  return { __esModule: true, useSettingsStore }
})

import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DEFAULT_SKILL_PANEL_PREFS, SKILL_ENABLED_WARN_MAX } from "@/lib/skills/preferences"
import { useSkillPanelPrefs } from "@/hooks/skills"
import { useSettingsStore } from "@/stores/settings"
import { SkillPreferencesForm, SkillPreferencesPopover } from "./skill-preferences"

const mockUsePrefs = useSkillPanelPrefs as jest.Mock

function setPrefsSpy() {
  return useSettingsStore.getState().setSkillPanelPrefs as unknown as jest.Mock
}

beforeEach(() => {
  mockUsePrefs.mockReturnValue({ ...DEFAULT_SKILL_PANEL_PREFS })
  ;(useSettingsStore.setState as (p: unknown) => void)({ setSkillPanelPrefs: jest.fn() })
})

describe("SkillPreferencesForm", () => {
  it("renders the three preference groups", () => {
    render(<SkillPreferencesForm />)
    expect(screen.getByText("prefs.display")).toBeInTheDocument()
    expect(screen.getByText("prefs.panel")).toBeInTheDocument()
    expect(screen.getByText("prefs.injection")).toBeInTheDocument()
  })

  it("renders all display field toggles", () => {
    render(<SkillPreferencesForm />)
    expect(screen.getByTestId("pref-show-description")).toBeInTheDocument()
    expect(screen.getByTestId("pref-show-tags")).toBeInTheDocument()
    expect(screen.getByTestId("pref-show-source")).toBeInTheDocument()
    expect(screen.getByTestId("pref-show-usage")).toBeInTheDocument()
  })

  it("persists a display toggle change", () => {
    render(<SkillPreferencesForm />)
    fireEvent.click(screen.getByTestId("pref-show-tags"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ showTags: true })
  })

  it("persists the remaining field-visibility toggles", () => {
    render(<SkillPreferencesForm />)
    fireEvent.click(screen.getByTestId("pref-show-description"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ showDescription: false })
    fireEvent.click(screen.getByTestId("pref-show-source"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ showSource: true })
    fireEvent.click(screen.getByTestId("pref-show-usage"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ showUsage: true })
  })

  it("persists the density select", async () => {
    const user = userEvent.setup()
    render(<SkillPreferencesForm />)
    await user.click(screen.getByLabelText("prefs.density"))
    await user.click(await screen.findByText("prefs.densityCompact"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ density: "compact" })
  })

  it("persists the view-mode select", async () => {
    const user = userEvent.setup()
    render(<SkillPreferencesForm />)
    await user.click(screen.getByLabelText("prefs.viewMode"))
    await user.click(await screen.findByText("prefs.viewGrid"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ viewMode: "grid" })
  })

  it("persists the default-tab select", async () => {
    const user = userEvent.setup()
    render(<SkillPreferencesForm />)
    await user.click(screen.getByLabelText("prefs.defaultTab"))
    await user.click(await screen.findByText("tabs.browse"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ defaultTab: "browse" })
  })

  it("persists the default-sort select", async () => {
    const user = userEvent.setup()
    render(<SkillPreferencesForm />)
    await user.click(screen.getByLabelText("prefs.defaultSort"))
    await user.click(await screen.findByText("filter.sortUpdated"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ defaultSort: "updated" })
  })

  it("persists the default-status select", async () => {
    const user = userEvent.setup()
    render(<SkillPreferencesForm />)
    await user.click(screen.getByLabelText("prefs.defaultStatus"))
    await user.click(await screen.findByText("status.enabled"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ defaultStatusFilter: "enabled" })
  })

  it("persists the auto-enable toggle change", () => {
    render(<SkillPreferencesForm />)
    // default autoEnableNew is true → clicking flips it off.
    fireEvent.click(screen.getByTestId("pref-auto-enable-new"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ autoEnableNew: false })
  })

  it("persists the remember-last-view toggle change", () => {
    render(<SkillPreferencesForm />)
    fireEvent.click(screen.getByTestId("pref-remember-last-view"))
    expect(setPrefsSpy()).toHaveBeenCalledWith({ rememberLastView: true })
  })

  it("clamps and persists the enabled-warn threshold", () => {
    render(<SkillPreferencesForm />)
    const input = screen.getByTestId("pref-enabled-warn-threshold")
    fireEvent.change(input, { target: { value: "5" } })
    expect(setPrefsSpy()).toHaveBeenCalledWith({ enabledWarnThreshold: 5 })
  })

  it("caps the threshold at the maximum", () => {
    render(<SkillPreferencesForm />)
    const input = screen.getByTestId("pref-enabled-warn-threshold")
    fireEvent.change(input, { target: { value: String(SKILL_ENABLED_WARN_MAX + 100) } })
    expect(setPrefsSpy()).toHaveBeenCalledWith({ enabledWarnThreshold: SKILL_ENABLED_WARN_MAX })
  })

  it("reflects stored overrides in the controls", () => {
    mockUsePrefs.mockReturnValue({
      ...DEFAULT_SKILL_PANEL_PREFS,
      enabledWarnThreshold: 7,
    })
    render(<SkillPreferencesForm />)
    expect(screen.getByTestId("pref-enabled-warn-threshold")).toHaveValue(7)
  })
})

describe("SkillPreferencesPopover", () => {
  it("renders a localized gear trigger", () => {
    render(<SkillPreferencesPopover />)
    expect(screen.getByTestId("skill-preferences-trigger")).toBeInTheDocument()
    expect(screen.getByLabelText("prefs.openAria")).toBeInTheDocument()
  })
})
