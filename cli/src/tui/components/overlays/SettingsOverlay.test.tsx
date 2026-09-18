import React from "react"
import { act, render } from "@testing-library/react"
import { __fireInput as fireInput, __resetInk } from "ink"

import { CliI18nProvider } from "../../i18n"
import { RenderPrefsProvider } from "../../render/context"
import { RENDER_DEFAULTS } from "../../../config/schema"
import { SettingsOverlay } from "./SettingsOverlay"
import type { SettingsSectionView } from "../../runtime/settings-sections"

function __fireInput(...args: Parameters<typeof fireInput>) {
  act(() => fireInput(...args))
}

const sections: SettingsSectionView[] = [
  {
    id: "model",
    title: "Model",
    rows: [
      {
        id: "provider",
        label: "Provider",
        value: "anthropic",
        control: { type: "delegate", command: "/provider" },
      },
      {
        id: "credential",
        label: "Credential",
        value: "API key configured",
        control: { type: "credential" },
      },
    ],
  },
  {
    id: "appearance",
    title: "Appearance",
    rows: [
      {
        id: "theme",
        label: "Theme",
        value: "dark",
        control: {
          type: "enum",
          options: ["classic", "dark", "light"],
          current: "dark",
          apply: { kind: "theme" },
        },
        description: "TUI colour theme.",
      },
      {
        id: "mascot",
        label: "Mascot",
        value: "on",
        control: { type: "boolean", current: true, apply: { kind: "mascotEnabled" } },
        description: "Show the terminal mascot.",
      },
    ],
  },
]

function setup(over: Partial<React.ComponentProps<typeof SettingsOverlay>> = {}) {
  const mocks = {
    onMoveRow: jest.fn(),
    onSwitchSection: jest.fn(),
    onAdjust: jest.fn(),
    onToggle: jest.fn(),
    onActivate: jest.fn(),
    onReset: jest.fn(),
    onClose: jest.fn(),
  }
  const props = { sections, section: 0, index: 0, ...mocks, ...over }
  const r = render(<SettingsOverlay {...props} />)
  return { ...props, ...mocks, ...r }
}

describe("SettingsOverlay", () => {
  beforeEach(() => __resetInk())

  it("renders the section tabs, highlighting the active one", () => {
    const { container } = setup({ section: 1 })
    const text = container.textContent ?? ""
    expect(text).toContain("Settings")
    expect(text).toContain("[Appearance]")
    expect(text).toContain("Model")
  })

  it("renders the active section's rows with their values", () => {
    const { container } = setup({ section: 1, index: 0 })
    const text = container.textContent ?? ""
    expect(text).toContain("Theme")
    expect(text).toContain("dark")
    expect(text).not.toContain("‹ dark ›") // arrows belong to editing mode
    expect(text).toContain("[x]") // boolean on
  })

  it("Tab switches section forward, Shift+Tab backward", () => {
    const { onSwitchSection } = setup()
    __fireInput("", { tab: true })
    __fireInput("", { tab: true, shift: true })
    expect(onSwitchSection).toHaveBeenNthCalledWith(1, 1)
    expect(onSwitchSection).toHaveBeenNthCalledWith(2, -1)
  })

  it("↑/↓ move the focused row", () => {
    const { onMoveRow } = setup({ section: 1 })
    __fireInput("", { downArrow: true })
    __fireInput("", { upArrow: true })
    expect(onMoveRow).toHaveBeenNthCalledWith(1, 1)
    expect(onMoveRow).toHaveBeenNthCalledWith(2, -1)
  })

  it("←/→ always switches sections while browsing an enum row", () => {
    const { onAdjust, onSwitchSection } = setup({ section: 1, index: 0 })
    __fireInput("", { rightArrow: true })
    __fireInput("", { leftArrow: true })
    expect(onSwitchSection).toHaveBeenNthCalledWith(1, 1)
    expect(onSwitchSection).toHaveBeenNthCalledWith(2, -1)
    expect(onAdjust).not.toHaveBeenCalled()
  })

  it("←/→ switches section when the focused row is not an enum", () => {
    const { onSwitchSection } = setup({ section: 0, index: 0 }) // delegate row
    __fireInput("", { rightArrow: true })
    expect(onSwitchSection).toHaveBeenCalledWith(1)
  })

  it("Space toggles a boolean row", () => {
    const { onToggle } = setup({ section: 1, index: 1 })
    __fireInput(" ", {})
    expect(onToggle).toHaveBeenCalledWith(sections[1].rows[1])
  })

  it("Enter activates a delegate row", () => {
    const { onActivate } = setup({ section: 0, index: 0 })
    __fireInput("", { return: true })
    expect(onActivate).toHaveBeenCalledWith(sections[0].rows[0])
  })

  it("Enter activates a credential row", () => {
    const { onActivate } = setup({ section: 0, index: 1 })
    __fireInput("", { return: true })
    expect(onActivate).toHaveBeenCalledWith(sections[0].rows[1])
  })

  it("edits an enum only after Enter and saves only on confirmation", () => {
    const { onAdjust, onSwitchSection, container } = setup({ section: 1, index: 0 })
    __fireInput("", { return: true })
    __fireInput("", { rightArrow: true })
    expect(container.textContent).toContain("‹ light ›")
    expect(onAdjust).not.toHaveBeenCalled()
    expect(onSwitchSection).not.toHaveBeenCalled()
    __fireInput("", { return: true })
    expect(onAdjust).toHaveBeenCalledWith(sections[1].rows[0], 1)
  })

  it("Esc cancels an edit without closing settings or writing a value", () => {
    const { onAdjust, onClose, container } = setup({ section: 1, index: 0 })
    __fireInput("", { return: true })
    __fireInput("", { rightArrow: true })
    __fireInput("", { escape: true })
    expect(container.textContent).toContain("dark")
    expect(onAdjust).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("Tab leaves an unsaved edit and switches section without saving", () => {
    const { onAdjust, onSwitchSection } = setup({ section: 1, index: 0 })
    __fireInput("", { return: true })
    __fireInput("", { leftArrow: true })
    __fireInput("", { tab: true })
    expect(onSwitchSection).toHaveBeenCalledWith(1)
    expect(onAdjust).not.toHaveBeenCalled()
  })

  it("Esc closes the panel", () => {
    const { onClose } = setup()
    __fireInput("", { escape: true })
    expect(onClose).toHaveBeenCalled()
  })

  it("shows the focused row's description and 1-based position", () => {
    const { container } = setup({ section: 1, index: 1 })
    const text = container.textContent ?? ""
    expect(text).toContain("Show the terminal mascot.") // focused-row description strip
    expect(text).toContain("2/2") // row 2 of 2 in the Appearance section
  })

  it("r resets a focused enum/boolean row to its default", () => {
    const { onReset } = setup({ section: 1, index: 0 }) // enum theme row
    __fireInput("r", {})
    expect(onReset).toHaveBeenCalledWith(sections[1].rows[0])
  })

  it("r is a no-op on a non-resettable (delegate) row", () => {
    const { onReset } = setup({ section: 0, index: 0 }) // delegate provider row
    __fireInput("r", {})
    expect(onReset).not.toHaveBeenCalled()
  })
})

describe("label column", () => {
  beforeEach(() => __resetInk())

  it("cuts a label at the column cap so the value column cannot be pushed right", () => {
    const long: SettingsSectionView[] = [
      {
        id: "appearance",
        title: "Appearance",
        rows: [
          { id: "short", label: "Theme", value: "dark", control: { type: "readonly" } },
          {
            id: "long",
            // 40 columns: over the 34-column cap. `padEnd` would emit it whole
            // and shove this row's value four columns past every other row's.
            label: "A settings label that runs past the cap",
            value: "on",
            control: { type: "readonly" },
          },
        ],
      },
    ]
    const { container } = render(
      <SettingsOverlay
        sections={long}
        section={0}
        index={0}
        onMoveRow={() => undefined}
        onSwitchSection={() => undefined}
        onAdjust={() => undefined}
        onToggle={() => undefined}
        onActivate={() => undefined}
        onClose={() => undefined}
      />
    )
    const text = container.textContent ?? ""
    expect(text).toContain("A settings label that runs past t…")
    expect(text).not.toContain("A settings label that runs past the cap")
  })
})

it("localizes settings chrome and disabled status", () => {
  const props = {
    sections: [
      {
        ...sections[0],
        rows: sections[0].rows.map((row) => ({ ...row, unavailable: "diagnostic" })),
      },
    ],
    section: 0,
    index: 0,
    maxRows: 1,
    onMoveRow: jest.fn(),
    onSwitchSection: jest.fn(),
    onAdjust: jest.fn(),
    onToggle: jest.fn(),
    onActivate: jest.fn(),
    onClose: jest.fn(),
  }
  const { container } = render(
    <CliI18nProvider locale="zh-CN">
      <SettingsOverlay {...props} />
    </CliI18nProvider>
  )
  expect(container.textContent).toContain("设置")
  expect(container.textContent).toContain("不可用")
  expect(container.textContent).toContain("还有 1 项")
  expect(container.textContent).toContain("Tab 切分区")
})

describe("accessible and bounded settings navigation", () => {
  beforeEach(() => __resetInk())

  it("speaks boolean values in reader mode and still toggles on Enter", () => {
    const booleanRow = {
      ...sections[1].rows[1],
      value: "off",
      control: {
        type: "boolean" as const,
        current: false,
        apply: { kind: "mascotEnabled" as const },
      },
    }
    const props = {
      sections: [{ ...sections[1], rows: [booleanRow] }],
      section: 0,
      index: 0,
      onMoveRow: jest.fn(),
      onSwitchSection: jest.fn(),
      onAdjust: jest.fn(),
      onToggle: jest.fn(),
      onActivate: jest.fn(),
      onClose: jest.fn(),
    }
    const { container, rerender } = render(
      <RenderPrefsProvider prefs={RENDER_DEFAULTS} screenReader>
        <SettingsOverlay {...props} />
      </RenderPrefsProvider>
    )
    expect(container.textContent).toContain("off")
    expect(container.textContent).not.toContain("[ ]")
    __fireInput("", { return: true })
    expect(props.onToggle).toHaveBeenCalledWith(booleanRow)
    rerender(<SettingsOverlay {...props} />)
    expect(container.textContent).toContain("[ ]")
  })

  it("shows hidden rows above a scrolled settings selection", () => {
    const { container } = setup({ section: 1, index: 1, maxRows: 1 })
    expect(container.textContent).toContain("↑ 1 more")
    expect(container.textContent).toContain("Mascot")
    expect(container.textContent).not.toContain("‹ dark ›")
  })

  it("safely ignores editing keys while the section is empty", () => {
    const { container, onActivate, onToggle, onAdjust } = setup({ sections: [], section: 0 })
    expect(container.textContent).toContain("Settings")
    __fireInput("", { return: true })
    __fireInput(" ", {})
    __fireInput("r", {})
    expect(onActivate).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
    expect(onAdjust).not.toHaveBeenCalled()
  })
})

describe("settings draft and responsive chrome", () => {
  beforeEach(() => __resetInk())

  it("wraps draft values backward and abandons them when moving rows", () => {
    const { container, onAdjust, onMoveRow } = setup({ section: 1 })
    __fireInput("", { return: true })
    __fireInput("", { leftArrow: true })
    __fireInput("", { leftArrow: true })
    expect(container.textContent).toContain("‹ light ›")
    __fireInput("", { downArrow: true })
    expect(onMoveRow).toHaveBeenCalledWith(1)
    expect(onAdjust).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain("‹ light ›")
  })

  it("confirms an unchanged draft without persisting and supports bracket navigation", () => {
    const { onAdjust, onSwitchSection } = setup({ section: 1 })
    __fireInput("", { return: true })
    __fireInput("", { return: true })
    expect(onAdjust).not.toHaveBeenCalled()
    __fireInput("[", {})
    __fireInput("]", {})
    expect(onSwitchSection.mock.calls).toEqual([[-1], [1]])
  })

  it.each([40, 20])("keeps editing hints and the active tab at width %s", (width) => {
    const { container } = setup({ section: 1, width, viewportRows: 6 })
    expect(container.textContent).toContain("[Appearance]")
    expect(container.textContent).not.toContain("TUI colour theme.")
    __fireInput("", { return: true })
    expect(container.textContent).toContain("Esc")
    expect(container.textContent).toContain("‹ dark ›")
  })

  it("keeps the selected row in a tiny viewport and hides optional chrome", () => {
    const { container } = setup({ section: 1, index: 1, viewportRows: 3, width: 30 })
    expect(container.textContent).toContain("Mascot")
    expect(container.textContent).not.toContain("Settings")
    expect(container.textContent).not.toContain("more")
  })

  it("windows tabs at both ends and rows within the measured height", () => {
    const SECTION_IDS = [
      "model",
      "appearance",
      "display",
      "tools",
      "git",
      "behavior",
      "terminal",
      "logging",
    ] as const
    const many = SECTION_IDS.map((id, i) => ({
      ...sections[1],
      id,
      title: `Section${i}`,
      rows: Array.from({ length: 20 }, (_, j) => ({
        ...sections[1].rows[0],
        id: `row${j}`,
        label: `Row${j}`,
      })),
    }))
    const { container, rerender, ...props } = setup({
      sections: many,
      section: 0,
      index: 10,
      width: 40,
      viewportRows: 10,
    })
    expect(container.textContent).toContain("[Section0]")
    expect(container.textContent).toContain("Row10")
    expect(container.textContent).not.toContain("Row0")
    rerender(<SettingsOverlay {...props} section={7} />)
    expect(container.textContent).toContain("[Section7]")
    expect(container.textContent).not.toContain("Section0")
  })
})
