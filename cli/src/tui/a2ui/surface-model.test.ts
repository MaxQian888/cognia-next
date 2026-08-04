/** @jest-environment node */
import { buildA2UIRows, isDestructiveA2UIAction } from "./surface-model"
import type { TuiA2UISurface } from "./surface"

const NATIVE_COMPONENTS = [
  "Text",
  "Card",
  "Row",
  "Column",
  "List",
  "Table",
  "Divider",
  "Spacer",
  "Badge",
  "Alert",
  "Link",
  "Icon",
  "Progress",
  "Button",
  "TextField",
  "TextArea",
  "Select",
  "Checkbox",
  "Radio",
  "RadioGroup",
  "Toggle",
  "Slider",
  "DatePicker",
  "TimePicker",
  "DateTimePicker",
  "Tabs",
  "Accordion",
  "Image",
  "Chart",
  "Dialog",
]

describe("buildA2UIRows", () => {
  it.each(NATIVE_COMPONENTS)("renders a non-empty native %s row", (component) => {
    const surface: TuiA2UISurface = {
      surfaceId: "s",
      rootId: "root",
      dataModel: {},
      components: {
        root: {
          id: "root",
          component,
          text: "Label",
          label: "Label",
          title: "Title",
          message: "Message",
          value: component === "Progress" ? 50 : "value",
          max: 100,
          src: "https://image.test/a.png",
          href: "https://example.test",
          name: "circle",
          action: "submit",
          children: [],
          items: [{ id: "one", label: "One", title: "One", children: [] }],
          tabs: [{ id: "tab", label: "Tab", children: [] }],
          options: [{ label: "One", value: "one" }],
          columns: [{ key: "name", header: "Name" }],
          data: [{ name: "Ada", value: 2 }],
          chartType: "bar",
          open: true,
        },
      },
    }
    const rows = buildA2UIRows(surface, {})
    expect(rows.length).toBeGreaterThan(0)
    expect(
      rows
        .map((row) => row.text)
        .join(" ")
        .trim()
    ).not.toBe("")
  })

  it.each(["Animation", "InteractiveGuide", "RichOutput", "AcademicAnalysis", "CustomWidget"])(
    "renders explicit fallback for unsupported %s",
    (component) => {
      const surface: TuiA2UISurface = {
        surfaceId: "s",
        rootId: "root",
        dataModel: {},
        components: {
          root: {
            id: "root",
            component,
            fallbackContent: "Accessible fallback",
            raw: { answer: 42 },
          },
        },
      }
      const rows = buildA2UIRows(surface, {})
      expect(rows[0]).toMatchObject({ kind: "fallback" })
      expect(rows[0].text).toContain("Accessible fallback")
      expect(rows[0].text).toContain("raw data")
    }
  )

  it("marks destructive variants/actions for confirmation", () => {
    expect(isDestructiveA2UIAction({ variant: "destructive", action: "save" })).toBe(true)
    expect(isDestructiveA2UIAction({ action: "delete-project" })).toBe(true)
    expect(isDestructiveA2UIAction({ action: "save" })).toBe(false)
  })
})
