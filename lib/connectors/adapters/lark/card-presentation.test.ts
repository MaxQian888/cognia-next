import {
  DEFAULT_LARK_CARD_PRESENTATION,
  normalizeLarkCardPresentation,
  larkCardHeaderTheme,
  validateLarkCardPresentation,
  larkCardConfigStyle,
  larkCardHeaderExtras,
  larkCardMarkdownStyle,
  larkCardPanelStyle,
} from "./card-presentation"

it("normalizes malformed settings and preserves explicit false values", () => {
  expect(normalizeLarkCardPresentation(null)).toEqual(DEFAULT_LARK_CARD_PRESENTATION)
  expect(
    normalizeLarkCardPresentation({ theme: "url(bad)", width: 4, showQuote: "false" })
  ).toEqual(DEFAULT_LARK_CARD_PRESENTATION)
  expect(normalizeLarkCardPresentation({ theme: "purple", showElapsed: false })).toMatchObject({
    theme: "purple",
    showElapsed: false,
  })
})

it("validates editable drafts before normalization and disables malformed persisted templates", () => {
  const base = normalizeLarkCardPresentation({})
  expect(validateLarkCardPresentation({ ...base, resultTemplateEnabled: true })).toBe(
    "invalidTemplate"
  )
  expect(validateLarkCardPresentation({ ...base, panelColorLight: "#ffffff" })).toBe("invalidColor")
  expect(
    validateLarkCardPresentation({ ...base, headerIconKey: "https://example.com/icon.png" })
  ).toBe("invalidIcon")
  expect(validateLarkCardPresentation({ ...base, headerTags: "a,b,c,d" })).toBe("invalidTags")
  expect(
    normalizeLarkCardPresentation({
      resultTemplateEnabled: true,
      resultTemplateId: {},
      resultTemplateVersion: 2,
    }).resultTemplateEnabled
  ).toBe(false)
  expect(
    normalizeLarkCardPresentation({ panelColorLight: "rgba(bad)", desktopTextSize: "900px" })
  ).toMatchObject({ panelColorLight: "", desktopTextSize: "normal" })
})

it("renders documented named size/color styles and bounded header decorations", () => {
  const value = normalizeLarkCardPresentation({
    desktopTextSize: "heading-3",
    mobileTextSize: "heading-4",
    panelColorLight: "#123456",
    panelColorDark: "#abcdef",
    subtitle: "Progress",
    headerIconKey: "img_v3_test",
    headerTags: "alpha,beta,gamma,overflow",
  })
  expect(larkCardConfigStyle(value)).toEqual({
    style: {
      text_size: { "cognia-body": { default: "normal", pc: "heading-3", mobile: "heading-4" } },
      color: {
        "cognia-panel": { light_mode: "rgba(18,52,86,1)", dark_mode: "rgba(171,205,239,1)" },
      },
    },
  })
  expect(larkCardMarkdownStyle(value)).toEqual({ text_size: "cognia-body" })
  expect(larkCardPanelStyle(value)).toEqual({ background_color: "cognia-panel" })
  expect(larkCardHeaderExtras(value)).toMatchObject({
    subtitle: { content: "Progress" },
    icon: { tag: "custom_icon", img_key: "img_v3_test" },
  })
  expect(larkCardHeaderExtras(value).text_tag_list).toHaveLength(3)
  expect(larkCardConfigStyle(normalizeLarkCardPresentation({}))).toEqual({})
})

it("bounds custom titles and retains failure and waiting colors", () => {
  const custom = normalizeLarkCardPresentation({ title: "x".repeat(100), theme: "purple" })
  expect(custom.title.length).toBeLessThanOrEqual(60)
  expect(larkCardHeaderTheme(custom, "blue")).toBe("purple")
  expect(larkCardHeaderTheme(custom, "red")).toBe("red")
  expect(larkCardHeaderTheme(custom, "orange")).toBe("orange")
})
