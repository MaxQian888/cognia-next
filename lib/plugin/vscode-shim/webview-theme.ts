/**
 * The theme a VS Code webview sees: the `--vscode-*` CSS variables extensions
 * style their webviews with, and the `vscode-light` / `vscode-dark` body
 * class, taken from the app's own theme so a webview matches the window
 * around it.
 *
 * Each variable maps to one of the app's design tokens (`app/globals.css`).
 * The set covers what webview UI toolkits and the VS Code samples use; a
 * variable outside it is unset in the webview, as an unknown theme color is in
 * VS Code.
 */

export type VscodeThemeKind = "vscode-light" | "vscode-dark"

/** `--vscode-<name>` → the app token (`--<token>`) it takes its value from. */
export const VSCODE_THEME_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["foreground", "foreground"],
  ["descriptionForeground", "muted-foreground"],
  ["disabledForeground", "muted-foreground"],
  ["errorForeground", "destructive"],
  ["focusBorder", "ring"],
  ["contrastBorder", "border"],
  ["widget-border", "border"],
  ["widget-shadow", "border"],
  ["icon-foreground", "foreground"],
  ["editor-background", "background"],
  ["editor-foreground", "foreground"],
  ["editorWidget-background", "popover"],
  ["editorWidget-foreground", "popover-foreground"],
  ["editorWidget-border", "border"],
  ["sideBar-background", "background"],
  ["sideBar-foreground", "foreground"],
  ["sideBarTitle-foreground", "foreground"],
  ["sideBarSectionHeader-background", "muted"],
  ["sideBarSectionHeader-foreground", "foreground"],
  ["panel-background", "background"],
  ["panel-border", "border"],
  ["button-background", "primary"],
  ["button-foreground", "primary-foreground"],
  ["button-hoverBackground", "primary"],
  ["button-border", "primary"],
  ["button-secondaryBackground", "secondary"],
  ["button-secondaryForeground", "secondary-foreground"],
  ["button-secondaryHoverBackground", "accent"],
  ["input-background", "background"],
  ["input-foreground", "foreground"],
  ["input-border", "input"],
  ["input-placeholderForeground", "muted-foreground"],
  ["inputOption-activeBorder", "ring"],
  ["inputValidation-errorBorder", "destructive"],
  ["dropdown-background", "popover"],
  ["dropdown-foreground", "popover-foreground"],
  ["dropdown-border", "input"],
  ["dropdown-listBackground", "popover"],
  ["checkbox-background", "background"],
  ["checkbox-foreground", "foreground"],
  ["checkbox-border", "input"],
  ["list-hoverBackground", "accent"],
  ["list-hoverForeground", "accent-foreground"],
  ["list-activeSelectionBackground", "accent"],
  ["list-activeSelectionForeground", "accent-foreground"],
  ["list-inactiveSelectionBackground", "muted"],
  ["list-focusOutline", "ring"],
  ["badge-background", "primary"],
  ["badge-foreground", "primary-foreground"],
  ["progressBar-background", "primary"],
  ["textLink-foreground", "primary"],
  ["textLink-activeForeground", "primary"],
  ["textPreformat-foreground", "foreground"],
  ["textBlockQuote-background", "muted"],
  ["textBlockQuote-border", "border"],
  ["textCodeBlock-background", "muted"],
  ["textSeparator-foreground", "border"],
  ["scrollbarSlider-background", "muted"],
  ["scrollbarSlider-hoverBackground", "accent"],
  ["scrollbarSlider-activeBackground", "accent"],
  ["menu-background", "popover"],
  ["menu-foreground", "popover-foreground"],
  ["notifications-background", "popover"],
  ["notifications-foreground", "popover-foreground"],
  ["tab-activeBackground", "background"],
  ["tab-inactiveBackground", "muted"],
  ["toolbar-hoverBackground", "accent"],
]

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", sans-serif'
const EDITOR_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'

/**
 * The `:root` rule for a webview: the font variables VS Code sets, and each
 * theme variable whose app token `read` resolves.
 */
export function buildVscodeThemeCss(read: (token: string) => string): string {
  const declarations = [
    `--vscode-font-family: ${FONT_FAMILY}`,
    "--vscode-font-size: 13px",
    "--vscode-font-weight: normal",
    `--vscode-editor-font-family: ${EDITOR_FONT_FAMILY}`,
    "--vscode-editor-font-size: 13px",
    "--vscode-editor-font-weight: normal",
  ]
  for (const [name, token] of VSCODE_THEME_VARIABLES) {
    const value = read(token).trim()
    // A value that could end the rule is not a color.
    if (value && !/[;{}<]/.test(value)) declarations.push(`--vscode-${name}: ${value}`)
  }
  return `:root { ${declarations.join("; ")}; }`
}

/**
 * The defaults VS Code gives every webview body, so one that styles nothing
 * itself still reads as part of the window.
 */
export const VSCODE_WEBVIEW_DEFAULT_CSS = [
  "html { scrollbar-color: var(--vscode-scrollbarSlider-background) transparent; }",
  "body { background-color: transparent; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-weight: var(--vscode-font-weight); font-size: var(--vscode-font-size); margin: 0; padding: 0 20px; }",
  "img, video { max-width: 100%; max-height: 100%; }",
  "a, a code { color: var(--vscode-textLink-foreground); }",
  "a:hover { color: var(--vscode-textLink-activeForeground); }",
  "code { font-family: var(--vscode-editor-font-family); color: var(--vscode-textPreformat-foreground); }",
  "blockquote { background: var(--vscode-textBlockQuote-background); border-color: var(--vscode-textBlockQuote-border); }",
  ":focus { outline-color: var(--vscode-focusBorder); }",
].join("\n")

/** The app's current theme, read from the document. */
export function readAppTheme(): { css: string; kind: VscodeThemeKind } {
  if (typeof document === "undefined") {
    return { css: buildVscodeThemeCss(() => ""), kind: "vscode-light" }
  }
  const style = getComputedStyle(document.documentElement)
  return {
    css: buildVscodeThemeCss((token) => style.getPropertyValue(`--${token}`)),
    kind: document.documentElement.classList.contains("dark") ? "vscode-dark" : "vscode-light",
  }
}
