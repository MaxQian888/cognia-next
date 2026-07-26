/**
 * The app-palette → VS Code Theme Color table used to paint the embedded Pro IDE.
 *
 * # Why this is not the importer's table reversed
 *
 * `lib/appearance/vscode-theme/token-mapping.ts` exists to *read* an arbitrary
 * third-party VS Code theme into cognia's 27 `ThemeColors` slots. It is a
 * sampling table: for each cognia slot it lists a few keys popular themes are
 * likely to define, and takes the first hit. Inverting it — which is what this
 * module used to do — produces roughly 30 keys, because that is all the sampling
 * needed. Everything else in the workbench (`titleBar.*`, `statusBar.*`,
 * `tab.inactiveBackground`, `terminal.*`, `menu.*`, `notifications.*`,
 * `editorSuggestWidget.*`, `breadcrumb.*`, `minimap.*`, the scrollbar, the
 * sashes …) therefore fell through to the base theme's stock VS Code grey — the
 * "the Pro IDE doesn't look like the app" report.
 *
 * The inversion also mis-assigned keys. Import resolves collisions with
 * "first non-empty wins", so exporting by walking the slots in declaration order
 * let `secondaryForeground` — a *text* color — claim `panel.border` before the
 * `border` slot could, and `input` / `card` / `destructiveForeground` /
 * `sidebarPrimary` emitted nothing at all because every key they listed had
 * already been taken.
 *
 * So export gets its own table, written from the palette outwards: for each
 * workbench surface, which cognia token *is* that surface. One direction each,
 * both explicit.
 *
 * # Alpha
 *
 * VS Code accepts `#RRGGBBAA` and composites it over whatever is behind. Overlay
 * surfaces (selection, hover, current-line, drag targets, indent guides) must be
 * translucent or they paint over the code they are meant to highlight, so those
 * keys carry an alpha suffix rather than an opaque token value.
 *
 * Reference: https://code.visualstudio.com/api/references/theme-color
 */
import type { ThemeColors } from "@/types/plugin/plugin"

/** A cognia palette slot, optionally composited at `alpha` (0..1). */
export interface ChromeSource {
  token: keyof ThemeColors
  /** Omit for fully opaque. Emitted as an `#RRGGBBAA` suffix. */
  alpha?: number
}

/**
 * Every VS Code color key cognia owns, and which palette slot paints it.
 *
 * Grouped by workbench area so a gap is visible by reading rather than by
 * diffing against the VS Code reference. Keys VS Code derives acceptably on its
 * own (most token/syntax colors, decorations that must stay semantic like
 * `gitDecoration.*` add/delete greens and reds) are deliberately absent — see
 * the note on syntax colors in `build-settings.ts`.
 */
export const VSCODE_CHROME_MAP: Record<string, ChromeSource> = {
  // ── Base ───────────────────────────────────────────────────────────────────
  foreground: { token: "foreground" },
  descriptionForeground: { token: "mutedForeground" },
  errorForeground: { token: "destructive" },
  focusBorder: { token: "ring" },
  "widget.border": { token: "border" },
  "widget.shadow": { token: "background", alpha: 0.36 },
  "sash.hoverBorder": { token: "ring" },
  "icon.foreground": { token: "mutedForeground" },
  "toolbar.hoverBackground": { token: "accent", alpha: 0.24 },
  "toolbar.activeBackground": { token: "accent", alpha: 0.36 },
  "selection.background": { token: "accent", alpha: 0.4 },
  "progressBar.background": { token: "primary" },

  // ── Title bar / command center / menus ─────────────────────────────────────
  // The single biggest offender before this table existed: the title bar sat at
  // the base theme's grey directly above the app's own chrome.
  "titleBar.activeBackground": { token: "sidebar" },
  "titleBar.inactiveBackground": { token: "sidebar" },
  "titleBar.activeForeground": { token: "sidebarForeground" },
  "titleBar.inactiveForeground": { token: "mutedForeground" },
  "titleBar.border": { token: "sidebarBorder" },
  "commandCenter.background": { token: "input" },
  "commandCenter.foreground": { token: "foreground" },
  "commandCenter.border": { token: "border" },
  "commandCenter.activeBackground": { token: "accent", alpha: 0.24 },
  "commandCenter.activeForeground": { token: "foreground" },
  "menubar.selectionBackground": { token: "accent", alpha: 0.3 },
  "menubar.selectionForeground": { token: "foreground" },
  "menu.background": { token: "popover" },
  "menu.foreground": { token: "popoverForeground" },
  "menu.border": { token: "border" },
  "menu.selectionBackground": { token: "accent" },
  "menu.selectionForeground": { token: "accentForeground" },
  "menu.separatorBackground": { token: "border" },

  // ── Activity bar ───────────────────────────────────────────────────────────
  "activityBar.background": { token: "sidebar" },
  "activityBar.foreground": { token: "sidebarForeground" },
  "activityBar.inactiveForeground": { token: "mutedForeground" },
  "activityBar.border": { token: "sidebarBorder" },
  "activityBar.activeBorder": { token: "sidebarPrimary" },
  "activityBar.activeBackground": { token: "sidebarAccent", alpha: 0.5 },
  "activityBarBadge.background": { token: "sidebarPrimary" },
  "activityBarBadge.foreground": { token: "sidebarPrimaryForeground" },
  "activityBarTop.background": { token: "sidebar" },
  "activityBarTop.foreground": { token: "sidebarForeground" },
  "activityBarTop.inactiveForeground": { token: "mutedForeground" },
  "activityBarTop.activeBorder": { token: "sidebarPrimary" },

  // ── Side bar / explorer ────────────────────────────────────────────────────
  "sideBar.background": { token: "sidebar" },
  "sideBar.foreground": { token: "sidebarForeground" },
  "sideBar.border": { token: "sidebarBorder" },
  "sideBarTitle.background": { token: "sidebar" },
  "sideBarTitle.foreground": { token: "sidebarForeground" },
  "sideBarSectionHeader.background": { token: "secondary", alpha: 0.35 },
  "sideBarSectionHeader.foreground": { token: "sidebarForeground" },
  "sideBarSectionHeader.border": { token: "sidebarBorder" },
  "sideBarActivityBarTop.border": { token: "sidebarBorder" },

  // ── Editor group / tabs ────────────────────────────────────────────────────
  "editorGroup.border": { token: "border" },
  "editorGroupHeader.tabsBackground": { token: "secondary", alpha: 0.35 },
  "editorGroupHeader.tabsBorder": { token: "border" },
  "editorGroupHeader.noTabsBackground": { token: "background" },
  "editorGroup.dropBackground": { token: "accent", alpha: 0.3 },
  "tab.activeBackground": { token: "background" },
  "tab.activeForeground": { token: "foreground" },
  "tab.inactiveBackground": { token: "secondary", alpha: 0.35 },
  "tab.inactiveForeground": { token: "mutedForeground" },
  "tab.hoverBackground": { token: "accent", alpha: 0.2 },
  "tab.hoverForeground": { token: "foreground" },
  "tab.border": { token: "border" },
  "tab.activeBorderTop": { token: "primary" },
  "tab.lastPinnedBorder": { token: "border" },
  "tab.unfocusedActiveBackground": { token: "background" },
  "tab.unfocusedActiveForeground": { token: "mutedForeground" },
  "tab.unfocusedInactiveForeground": { token: "mutedForeground" },
  "editorPane.background": { token: "background" },

  // ── Editor surface ─────────────────────────────────────────────────────────
  "editor.background": { token: "background" },
  "editor.foreground": { token: "foreground" },
  "editor.lineHighlightBackground": { token: "muted", alpha: 0.5 },
  "editor.lineHighlightBorder": { token: "muted", alpha: 0 },
  "editor.selectionBackground": { token: "accent", alpha: 0.35 },
  "editor.inactiveSelectionBackground": { token: "accent", alpha: 0.2 },
  "editor.selectionHighlightBackground": { token: "accent", alpha: 0.2 },
  "editor.wordHighlightBackground": { token: "accent", alpha: 0.18 },
  "editor.wordHighlightStrongBackground": { token: "accent", alpha: 0.26 },
  "editor.findMatchBackground": { token: "primary", alpha: 0.45 },
  "editor.findMatchHighlightBackground": { token: "primary", alpha: 0.24 },
  "editor.rangeHighlightBackground": { token: "accent", alpha: 0.16 },
  "editor.hoverHighlightBackground": { token: "accent", alpha: 0.16 },
  "editorCursor.foreground": { token: "primary" },
  "editorLineNumber.foreground": { token: "mutedForeground" },
  "editorLineNumber.activeForeground": { token: "foreground" },
  "editorGutter.background": { token: "background" },
  "editorIndentGuide.background1": { token: "border", alpha: 0.5 },
  "editorIndentGuide.activeBackground1": { token: "border" },
  "editorWhitespace.foreground": { token: "mutedForeground", alpha: 0.35 },
  "editorRuler.foreground": { token: "border" },
  "editorBracketMatch.background": { token: "accent", alpha: 0.24 },
  "editorBracketMatch.border": { token: "ring" },
  "editorLink.activeForeground": { token: "primary" },
  "editorOverviewRuler.border": { token: "border" },
  "editorStickyScroll.background": { token: "secondary", alpha: 0.55 },
  "editorStickyScrollHover.background": { token: "accent", alpha: 0.2 },
  "editorCodeLens.foreground": { token: "mutedForeground" },
  "editorInlayHint.background": { token: "muted", alpha: 0.5 },
  "editorInlayHint.foreground": { token: "mutedForeground" },
  "editorGhostText.foreground": { token: "mutedForeground" },

  // ── Widgets (find, suggest, hover, peek, inline chat) ─────────────────────
  "editorWidget.background": { token: "popover" },
  "editorWidget.foreground": { token: "popoverForeground" },
  "editorWidget.border": { token: "border" },
  "editorWidget.resizeBorder": { token: "ring" },
  "editorSuggestWidget.background": { token: "popover" },
  "editorSuggestWidget.foreground": { token: "popoverForeground" },
  "editorSuggestWidget.border": { token: "border" },
  "editorSuggestWidget.selectedBackground": { token: "accent" },
  "editorSuggestWidget.selectedForeground": { token: "accentForeground" },
  "editorSuggestWidget.highlightForeground": { token: "primary" },
  "editorHoverWidget.background": { token: "popover" },
  "editorHoverWidget.foreground": { token: "popoverForeground" },
  "editorHoverWidget.border": { token: "border" },
  "editorHoverWidget.statusBarBackground": { token: "secondary", alpha: 0.5 },
  "peekViewEditor.background": { token: "background" },
  "peekViewResult.background": { token: "card" },
  "peekViewResult.foreground": { token: "cardForeground" },
  "peekViewResult.selectionBackground": { token: "accent", alpha: 0.35 },
  "peekViewTitle.background": { token: "secondary", alpha: 0.5 },
  "peekViewTitleLabel.foreground": { token: "foreground" },
  "peekViewTitleDescription.foreground": { token: "mutedForeground" },
  "peekView.border": { token: "border" },
  "debugToolBar.background": { token: "popover" },

  // ── Quick input / command palette ──────────────────────────────────────────
  "quickInput.background": { token: "popover" },
  "quickInput.foreground": { token: "popoverForeground" },
  "quickInputTitle.background": { token: "secondary", alpha: 0.5 },
  "quickInputList.focusBackground": { token: "accent" },
  "quickInputList.focusForeground": { token: "accentForeground" },
  "pickerGroup.foreground": { token: "mutedForeground" },
  "pickerGroup.border": { token: "border" },
  "keybindingLabel.background": { token: "muted" },
  "keybindingLabel.foreground": { token: "foreground" },
  "keybindingLabel.border": { token: "border" },
  "keybindingLabel.bottomBorder": { token: "border" },

  // ── Lists / trees ──────────────────────────────────────────────────────────
  "list.activeSelectionBackground": { token: "sidebarPrimary" },
  "list.activeSelectionForeground": { token: "sidebarPrimaryForeground" },
  "list.inactiveSelectionBackground": { token: "sidebarAccent", alpha: 0.7 },
  "list.inactiveSelectionForeground": { token: "sidebarAccentForeground" },
  "list.hoverBackground": { token: "sidebarAccent", alpha: 0.45 },
  "list.hoverForeground": { token: "sidebarAccentForeground" },
  "list.focusBackground": { token: "accent", alpha: 0.35 },
  "list.focusForeground": { token: "foreground" },
  "list.focusOutline": { token: "sidebarRing" },
  "list.highlightForeground": { token: "primary" },
  "list.dropBackground": { token: "accent", alpha: 0.3 },
  "tree.indentGuidesStroke": { token: "border" },
  "tree.tableColumnsBorder": { token: "border" },

  // ── Inputs / dropdowns / buttons / badges ──────────────────────────────────
  "input.background": { token: "input" },
  "input.foreground": { token: "foreground" },
  "input.border": { token: "border" },
  "input.placeholderForeground": { token: "mutedForeground" },
  "inputOption.activeBackground": { token: "primary", alpha: 0.3 },
  "inputOption.activeForeground": { token: "foreground" },
  "inputOption.activeBorder": { token: "ring" },
  "inputValidation.errorBackground": { token: "destructive", alpha: 0.2 },
  "inputValidation.errorForeground": { token: "foreground" },
  "inputValidation.errorBorder": { token: "destructive" },
  "dropdown.background": { token: "popover" },
  "dropdown.listBackground": { token: "popover" },
  "dropdown.foreground": { token: "popoverForeground" },
  "dropdown.border": { token: "border" },
  "button.background": { token: "primary" },
  "button.foreground": { token: "primaryForeground" },
  "button.hoverBackground": { token: "primary", alpha: 0.86 },
  "button.border": { token: "border" },
  "button.secondaryBackground": { token: "secondary" },
  "button.secondaryForeground": { token: "secondaryForeground" },
  "button.secondaryHoverBackground": { token: "secondary", alpha: 0.86 },
  "checkbox.background": { token: "input" },
  "checkbox.foreground": { token: "foreground" },
  "checkbox.border": { token: "border" },
  "badge.background": { token: "primary" },
  "badge.foreground": { token: "primaryForeground" },
  "textLink.foreground": { token: "primary" },
  "textLink.activeForeground": { token: "primary" },
  "textBlockQuote.background": { token: "muted", alpha: 0.5 },
  "textBlockQuote.border": { token: "border" },
  "textCodeBlock.background": { token: "muted", alpha: 0.6 },
  "textPreformat.foreground": { token: "primary" },
  "textSeparator.foreground": { token: "border" },

  // ── Scrollbar / minimap ────────────────────────────────────────────────────
  "scrollbar.shadow": { token: "background", alpha: 0.3 },
  "scrollbarSlider.background": { token: "mutedForeground", alpha: 0.24 },
  "scrollbarSlider.hoverBackground": { token: "mutedForeground", alpha: 0.36 },
  "scrollbarSlider.activeBackground": { token: "mutedForeground", alpha: 0.5 },
  "minimap.background": { token: "background" },
  "minimap.selectionHighlight": { token: "accent", alpha: 0.5 },
  "minimap.findMatchHighlight": { token: "primary", alpha: 0.6 },
  "minimapSlider.background": { token: "mutedForeground", alpha: 0.16 },
  "minimapSlider.hoverBackground": { token: "mutedForeground", alpha: 0.26 },
  "minimapSlider.activeBackground": { token: "mutedForeground", alpha: 0.36 },

  // ── Panel / terminal / status bar ─────────────────────────────────────────
  "panel.background": { token: "card" },
  "panel.border": { token: "border" },
  "panelTitle.activeForeground": { token: "foreground" },
  "panelTitle.inactiveForeground": { token: "mutedForeground" },
  "panelTitle.activeBorder": { token: "primary" },
  "panelSection.border": { token: "border" },
  "panelSectionHeader.background": { token: "secondary", alpha: 0.35 },
  "panelSectionHeader.foreground": { token: "foreground" },
  "terminal.background": { token: "card" },
  "terminal.foreground": { token: "cardForeground" },
  "terminal.border": { token: "border" },
  "terminal.selectionBackground": { token: "accent", alpha: 0.35 },
  "terminalCursor.foreground": { token: "primary" },
  "terminalCursor.background": { token: "card" },
  "statusBar.background": { token: "sidebar" },
  "statusBar.foreground": { token: "sidebarForeground" },
  "statusBar.border": { token: "sidebarBorder" },
  "statusBar.noFolderBackground": { token: "sidebar" },
  "statusBar.debuggingBackground": { token: "sidebar" },
  "statusBar.debuggingForeground": { token: "sidebarForeground" },
  "statusBarItem.hoverBackground": { token: "sidebarAccent", alpha: 0.5 },
  "statusBarItem.activeBackground": { token: "sidebarAccent" },
  "statusBarItem.prominentBackground": { token: "sidebarPrimary" },
  "statusBarItem.prominentForeground": { token: "sidebarPrimaryForeground" },
  "statusBarItem.remoteBackground": { token: "sidebarPrimary" },
  "statusBarItem.remoteForeground": { token: "sidebarPrimaryForeground" },
  "statusBarItem.focusBorder": { token: "sidebarRing" },

  // ── Notifications / banner / breadcrumbs ──────────────────────────────────
  "notificationCenter.border": { token: "border" },
  "notificationCenterHeader.background": { token: "secondary", alpha: 0.5 },
  "notificationCenterHeader.foreground": { token: "foreground" },
  "notificationToast.border": { token: "border" },
  "notifications.background": { token: "popover" },
  "notifications.foreground": { token: "popoverForeground" },
  "notifications.border": { token: "border" },
  "notificationLink.foreground": { token: "primary" },
  "banner.background": { token: "secondary" },
  "banner.foreground": { token: "secondaryForeground" },
  "banner.iconForeground": { token: "primary" },
  "breadcrumb.background": { token: "background" },
  "breadcrumb.foreground": { token: "mutedForeground" },
  "breadcrumb.focusForeground": { token: "foreground" },
  "breadcrumb.activeSelectionForeground": { token: "foreground" },
  "breadcrumbPicker.background": { token: "popover" },

  // ── Settings editor / welcome ─────────────────────────────────────────────
  "settings.headerForeground": { token: "foreground" },
  "settings.modifiedItemIndicator": { token: "primary" },
  "settings.dropdownBackground": { token: "popover" },
  "settings.dropdownForeground": { token: "popoverForeground" },
  "settings.dropdownBorder": { token: "border" },
  "settings.textInputBackground": { token: "input" },
  "settings.textInputForeground": { token: "foreground" },
  "settings.textInputBorder": { token: "border" },
  "settings.numberInputBackground": { token: "input" },
  "settings.numberInputForeground": { token: "foreground" },
  "settings.numberInputBorder": { token: "border" },
  "settings.checkboxBackground": { token: "input" },
  "settings.checkboxForeground": { token: "foreground" },
  "settings.checkboxBorder": { token: "border" },
  "settings.focusedRowBackground": { token: "accent", alpha: 0.14 },
  "settings.rowHoverBackground": { token: "accent", alpha: 0.1 },
  "welcomePage.background": { token: "background" },
  "welcomePage.tileBackground": { token: "card" },
  "welcomePage.tileHoverBackground": { token: "accent", alpha: 0.2 },
  "welcomePage.progress.background": { token: "muted" },
  "welcomePage.progress.foreground": { token: "primary" },

  // ── Notebook / chat / diff ────────────────────────────────────────────────
  "notebook.editorBackground": { token: "background" },
  "notebook.cellEditorBackground": { token: "background" },
  "notebook.cellBorderColor": { token: "border" },
  "notebook.focusedCellBorder": { token: "ring" },
  "notebook.selectedCellBackground": { token: "accent", alpha: 0.12 },
  "chat.requestBackground": { token: "card" },
  "chat.requestBorder": { token: "border" },
  "chat.slashCommandForeground": { token: "primary" },
  "diffEditor.border": { token: "border" },
  "diffEditor.diagonalFill": { token: "border", alpha: 0.5 },
  "diffEditor.unchangedRegionBackground": { token: "muted", alpha: 0.4 },
}

/** Every VS Code key this module owns. Exported for the merge + its tests. */
export const VSCODE_CHROME_KEYS: readonly string[] = Object.keys(VSCODE_CHROME_MAP)
