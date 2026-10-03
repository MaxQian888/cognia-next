/**
 * @jest-environment jsdom
 */

import {
  __resetDecorationCssForTesting,
  buildDecorationStyles,
  cssColor,
  installDecorationCss,
  removeDecorationCss,
  unsupportedDecorationOptions,
} from "./decoration-styles"

beforeEach(() => __resetDecorationCssForTesting())

describe("decoration styles", () => {
  it("resolves theme colors to variables, with fallbacks for common ones", () => {
    expect(cssColor("#fff")).toBe("#fff")
    expect(cssColor({ id: "editorError.foreground" })).toBe(
      "var(--vscode-editorError-foreground, #f14c4c)"
    )
    expect(cssColor({ id: "my.custom" })).toBe("var(--vscode-my-custom)")
    expect(cssColor(undefined)).toBeUndefined()
  })

  it("styles inline text, attachments and light/dark variants", () => {
    const { classes, css } = buildDecorationStyles("vsdeco-x", {
      color: "red",
      fontWeight: "bold",
      before: { contentText: 'a"b\\c\nd', margin: "0 4px" },
      after: { backgroundColor: "blue" },
      dark: { color: "pink" },
      light: { after: { color: "black" } },
    })
    expect(classes).toMatchObject({
      inlineClassName: "vsdeco-x-text",
      beforeContentClassName: "vsdeco-x-before",
      afterContentClassName: "vsdeco-x-after",
      isWholeLine: false,
    })
    expect(css).toContain(".vsdeco-x-text { font-weight: bold; color: red; }")
    expect(css).toContain(
      '.vsdeco-x-before::before { content: "a\\"b\\\\c\\a d"; margin: 0 4px; display: inline-block; }'
    )
    // An attachment without text still needs `content` to render.
    expect(css).toContain(
      '.vsdeco-x-after::after { content: ""; background-color: blue; display: inline-block; }'
    )
    expect(css).toContain(".dark .vsdeco-x-text { color: pink; }")
    expect(css).toContain(":root:not(.dark) .vsdeco-x-after::after")
  })

  it("uses the line class for whole-line decorations, and keeps stickiness and the ruler", () => {
    const { classes } = buildDecorationStyles("b", {
      isWholeLine: true,
      backgroundColor: "#eee",
      rangeBehavior: 3,
      overviewRulerColor: { id: "editorOverviewRuler.errorForeground" },
      overviewRulerLane: 4,
    })
    expect(classes).toEqual({
      isWholeLine: true,
      className: "b-text",
      stickiness: 3,
      overviewRuler: {
        color: "var(--vscode-editorOverviewRuler-errorForeground, rgba(255, 18, 18, 0.7))",
        position: 4,
      },
    })
  })

  it("lists the options it cannot draw", () => {
    expect(
      unsupportedDecorationOptions({
        gutterIconPath: "/x.svg",
        cursor: "pointer",
        dark: { after: { contentIconPath: "/y.svg" } },
      })
    ).toEqual(["gutterIconPath", "cursor", "after.contentIconPath"])
    expect(unsupportedDecorationOptions({ color: "red" })).toEqual([])
  })

  it("keeps one style element with every owner's rules", () => {
    installDecorationCss("a", ".a {}")
    installDecorationCss("b", ".b {}")
    const element = document.getElementById("cognia-vscode-decorations")
    expect(element?.textContent).toBe(".a {}\n.b {}")
    removeDecorationCss("a")
    expect(element?.textContent).toBe(".b {}")
  })
})
