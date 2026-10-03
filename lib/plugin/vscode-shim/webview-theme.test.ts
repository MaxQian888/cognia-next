/**
 * @jest-environment jsdom
 */

import {
  buildVscodeThemeCss,
  readAppTheme,
  VSCODE_THEME_VARIABLES,
  VSCODE_WEBVIEW_DEFAULT_CSS,
} from "./webview-theme"

it("maps each VS Code variable to the app token, skipping unset and unsafe values", () => {
  const tokens: Record<string, string> = {
    foreground: " oklch(0.2 0 0) ",
    primary: "oklch(0.5 0.1 200)",
    border: "red; } body { color: blue",
  }
  const css = buildVscodeThemeCss((token) => tokens[token] ?? "")
  expect(css.startsWith(":root { ")).toBe(true)
  expect(css).toContain("--vscode-foreground: oklch(0.2 0 0)")
  expect(css).toContain("--vscode-button-background: oklch(0.5 0.1 200)")
  expect(css).toContain("--vscode-font-size: 13px")
  expect(css).not.toContain("--vscode-panel-border")
  expect(css).not.toContain("body { color")
  expect(css).not.toContain("--vscode-input-background")
})

it("covers the variables webview toolkits read, each once", () => {
  const names = VSCODE_THEME_VARIABLES.map(([name]) => name)
  expect(new Set(names).size).toBe(names.length)
  for (const name of ["editor-background", "button-background", "input-border", "focusBorder"]) {
    expect(names).toContain(name)
  }
  expect(VSCODE_WEBVIEW_DEFAULT_CSS).toContain("var(--vscode-foreground)")
})

it("reads the app's tokens and dark mode from the document", () => {
  document.documentElement.style.setProperty("--foreground", "oklch(0.9 0 0)")
  document.documentElement.classList.add("dark")
  const dark = readAppTheme()
  expect(dark.kind).toBe("vscode-dark")
  expect(dark.css).toContain("--vscode-foreground: oklch(0.9 0 0)")
  document.documentElement.classList.remove("dark")
  expect(readAppTheme().kind).toBe("vscode-light")
})
