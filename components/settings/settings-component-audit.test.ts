import fs from "node:fs"
import path from "node:path"

const SETTINGS_ROOT = path.join(process.cwd(), "components/settings")
const SOURCE_FILE_PATTERN = /\.tsx$/
const EXCLUDED_FILE_PATTERN = /\.(?:test|stories)\.tsx$/
const NATIVE_INTERACTIVE_PATTERN =
  /^<(?:button|input|select|textarea|table|details|summary|progress)(?:[\t />]|$)/

function productionSettingsFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) return productionSettingsFiles(absolutePath)
    if (!SOURCE_FILE_PATTERN.test(entry.name) || EXCLUDED_FILE_PATTERN.test(entry.name)) return []
    return [absolutePath]
  })
}

describe("settings component primitives", () => {
  const sources = productionSettingsFiles(SETTINGS_ROOT).map((file) => ({
    file: path.relative(process.cwd(), file),
    source: fs.readFileSync(file, "utf8"),
  }))

  it("does not increase the remaining native interactive component debt", () => {
    const violations = sources
      .filter(({ source }) =>
        source.split("\n").some((line) => NATIVE_INTERACTIVE_PATTERN.test(line.trimStart()))
      )
      .map(({ file }) => file)

    expect(violations).not.toEqual(
      expect.arrayContaining([
        "components/settings/a2ui/templates-tab.tsx",
        "components/settings/actions/settings-actions-menu.tsx",
        "components/settings/agent/custom-mode-settings.tsx",
        "components/settings/appearance/components/appearance-config-toolbar.tsx",
        "components/settings/appearance/components/appearance-nav.tsx",
        "components/settings/appearance/components/color-token-row.tsx",
        "components/settings/appearance/components/cursor-effect-card.tsx",
        "components/settings/appearance/components/cursor-pack-grid.tsx",
        "components/settings/appearance/components/saved-themes-rail.tsx",
        "components/settings/appearance/components/wallpaper-uploader.tsx",
        "components/settings/appearance/components/wallpaper-card.tsx",
        "components/settings/appearance/tabs/custom-theme-tab.tsx",
        "components/settings/appearance/tabs/preset-grid.tsx",
        "components/settings/appearance/tabs/theme-tab.tsx",
        "components/settings/appearance/tabs/wallpaper-tab.tsx",
        "components/settings/characters-section.tsx",
        "components/settings/connections/tabs/labels-tab.tsx",
        "components/settings/pet/pet-model-manager.tsx",
        "components/settings/profile/profile-avatar-picker.tsx",
        "components/settings/prompt-presets-section.tsx",
        "components/settings/subagents/subagent-import-dialog.tsx",
        "components/settings/tray-section.tsx",
        "components/settings/provider/model-list-dialog.tsx",
        "components/settings/provider/provider-import-export.tsx",
        "components/settings/search/_shared/source-pill.tsx",
        "components/settings/companion/webrtc-card.tsx",
        "components/settings/connections/forms/quiet-hours-and-mute.tsx",
        "components/settings/connections/tabs/canned-responses-tab.tsx",
        "components/settings/pet/pet-model-config-dialog.tsx",
        "components/settings/pet/pet-model-motion-editor.tsx",
        "components/settings/notifications/notifications-section.tsx",
        "components/settings/provider/model-catalog-section.tsx",
        "components/settings/security/auto-lock-control.tsx",
        "components/settings/tray-panel/tray-panel-field-editor.tsx",
      ])
    )
    expect(violations.length).toBeLessThanOrEqual(56)
  })
})
