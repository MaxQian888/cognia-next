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
        "components/settings/a2ui/debugger-tab.tsx",
        "components/settings/a2ui/templates-tab.tsx",
        "components/settings/actions/settings-actions-menu.tsx",
        "components/settings/about/resources-card.tsx",
        "components/settings/about/tech-stack.tsx",
        "components/settings/agent/custom-mode-settings.tsx",
        "components/settings/agent/external-agent-settings.tsx",
        "components/settings/agent-runtime/tabs/sidecar-tab.tsx",
        "components/settings/agent-runtime/tool-search-runtime-card.tsx",
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
        "components/settings/appearance/vscode-import-form.tsx",
        "components/settings/characters-section.tsx",
        "components/settings/automation/inspector-tab.tsx",
        "components/settings/common/related-sections-strip.tsx",
        "components/settings/common/settings-panel-nav.tsx",
        "components/settings/connections/tabs/labels-tab.tsx",
        "components/settings/connections/adapters/add-connector-grid.tsx",
        "components/settings/connections/adapters/tabs/conversations-detail.tsx",
        "components/settings/connections/forms/_shared/quick-commands-editor.tsx",
        "components/settings/connections/forms/lark/lark-whitelist-editor.tsx",
        "components/settings/connections/tabs/conversations-tab.tsx",
        "components/settings/connections/tabs/outbound-tab.tsx",
        "components/settings/external-bridge/panels/audit-panel.tsx",
        "components/settings/external-bridge/panels/inbound-panel.tsx",
        "components/settings/fleet/fleet-history-panel.tsx",
        "components/settings/gateway/shared/chip-input.tsx",
        "components/settings/goals/goal-templates-manager.tsx",
        "components/settings/pet/pet-model-manager.tsx",
        "components/settings/profile/profile-avatar-picker.tsx",
        "components/settings/prompt-presets-section.tsx",
        "components/settings/presets/editor-sections/identity-section.tsx",
        "components/settings/presets/editor-sections/tools-section.tsx",
        "components/settings/presets/preset-card.tsx",
        "components/settings/hooks/builtin-hooks-card.tsx",
        "components/settings/memory/danger-zone.tsx",
        "components/settings/memory/memory-nav.tsx",
        "components/settings/mcp/mcp-panel.tsx",
        "components/settings/mcp/mcp-preset-grid.tsx",
        "components/settings/mcp/mcp-server-editor.tsx",
        "components/settings/mcp-drift-banner.tsx",
        "components/settings/mcp-agent-chip-group.tsx",
        "components/settings/mcp-import-dialog.tsx",
        "components/settings/search/search-settings-nav.tsx",
        "components/settings/search/_shared/domain-list-input.tsx",
        "components/settings/search/search-global-settings.tsx",
        "components/settings/slash-commands/command-editor-dialog.tsx",
        "components/settings/subagents/subagent-import-dialog.tsx",
        "components/settings/subagents/subagents-nav.tsx",
        "components/settings/subagents/tool-scope-field.tsx",
        "components/settings/subscription/components/subscription-nav.tsx",
        "components/settings/subscription/account-list.tsx",
        "components/settings/tray-section.tsx",
        "components/settings/teams-section.tsx",
        "components/settings/provider/model-list-dialog.tsx",
        "components/settings/provider/add-provider-popover.tsx",
        "components/settings/provider/add-provider-wizard.tsx",
        "components/settings/provider/local-provider-model-manager.tsx",
        "components/settings/provider/ollama-model-manager.tsx",
        "components/settings/provider/provider-sidebar-item.tsx",
        "components/settings/provider/quick-add-provider-dialog.tsx",
        "components/settings/provider/provider-import-export.tsx",
        "components/settings/provider/provider-onboarding-banner.tsx",
        "components/settings/search/_shared/source-pill.tsx",
        "components/settings/companion/webrtc-card.tsx",
        "components/settings/connections/forms/quiet-hours-and-mute.tsx",
        "components/settings/connections/tabs/canned-responses-tab.tsx",
        "components/settings/pet/pet-model-config-dialog.tsx",
        "components/settings/pet/pet-model-motion-editor.tsx",
        "components/settings/notifications/notifications-section.tsx",
        "components/settings/ocr/ocr-compare-view.tsx",
        "components/settings/ocr/ocr-sidebar-item.tsx",
        "components/settings/ocr/ocr-sidebar.tsx",
        "components/settings/ocr/tabs/ocr-platform-overrides-tab.tsx",
        "components/settings/provider/model-catalog-section.tsx",
        "components/settings/security/auto-lock-control.tsx",
        "components/settings/sections/diagnostics-section.tsx",
        "components/settings/system/crash-log-settings.tsx",
        "components/settings/tray-panel/tray-panel-field-editor.tsx",
      ])
    )
    expect(violations).toEqual([])
  })
})
