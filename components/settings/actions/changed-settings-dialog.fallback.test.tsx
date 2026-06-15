/**
 * @jest-environment jsdom
 *
 * Covers the dialog's defensive section-labeling branches: a group with no
 * owning section (→ "Other") and a group whose section id has no nav label
 * (→ raw id fallback). These shapes don't arise from the real registry (every
 * preference key is owned), so the diff module is mocked to produce them.
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: object; resetSettings: () => void }) => T) =>
    selector({ settings: { id: "singleton" }, resetSettings: jest.fn() }),
}))

jest.mock("sonner", () => ({ toast: { success: jest.fn() } }))

jest.mock("@/lib/settings/changed-settings", () => ({
  diffFromDefaults: () => [{ key: "x", sectionId: undefined, current: 1, default: 0 }],
  groupChangedBySection: () => [
    { sectionId: undefined, items: [{ key: "x", sectionId: undefined, current: 1, default: 0 }] },
    {
      sectionId: "ghost-section",
      items: [{ key: "y", sectionId: "ghost-section", current: 2, default: 0 }],
    },
  ],
  humanizeSettingKey: (k: string) => k,
  previewValue: (v: unknown) => String(v),
}))

import { ChangedSettingsDialog } from "./changed-settings-dialog"

describe("ChangedSettingsDialog section-label fallbacks", () => {
  it("labels an unowned group as 'other' and an unknown section by its id", () => {
    render(<ChangedSettingsDialog open onOpenChange={jest.fn()} />)
    expect(screen.getByText("changedReview.otherSection")).toBeInTheDocument()
    expect(screen.getByText("ghost-section")).toBeInTheDocument()
    expect(screen.getAllByTestId("changed-group")).toHaveLength(2)
  })
})
