import packageJson from "../package.json"
import fs from "node:fs"
import path from "node:path"

const exportsMap = packageJson.exports as Record<string, string>
const readme = fs.readFileSync(path.join(process.cwd(), "packages/plugin-sdk/README.md"), "utf8")

describe("plugin-sdk package exports", () => {
  it("publishes every implemented API subpath", () => {
    expect(exportsMap["./api/tools"]).toBe("./src/api/tool.ts")
    expect(exportsMap["./api/connector"]).toBe("./src/api/connector.ts")
    expect(exportsMap["./api/connectors"]).toBe("./src/api/connector.ts")
    expect(exportsMap["./api/components"]).toBe("./src/api/a2ui-component.ts")
    expect(exportsMap["./api/modes"]).toBe("./src/api/mode.ts")
    expect(exportsMap["./api/skills"]).toBe("./src/api/skill.ts")
    expect(exportsMap["./api/themes"]).toBe("./src/api/theme.ts")
    expect(exportsMap["./api/commands"]).toBe("./src/api/command.ts")
    expect(exportsMap["./api/exporters"]).toBe("./src/api/exporter.ts")
    expect(exportsMap["./api/importers"]).toBe("./src/api/importer.ts")
    expect(exportsMap["./api/scheduler"]).toBe("./src/api/scheduled-task.ts")
    expect(exportsMap["./api/tray"]).toBe("./src/api/tray-item.ts")
    expect(exportsMap["./api/hooks"]).toBe("./src/hooks/index.ts")
    expect(exportsMap["./api/fonts"]).toBe("./src/api/font-contribution.ts")
    expect(exportsMap["./api/wallpapers"]).toBe("./src/api/wallpaper.ts")
    expect(exportsMap["./api/tree-view"]).toBe("./src/api/view.ts")
    expect(exportsMap["./api/balance-adapter"]).toBe("./src/api/balance-adapter.ts")
    expect(exportsMap["./api/compaction-strategy"]).toBe("./src/api/compaction-strategy.ts")
    expect(exportsMap["./api/im-rate-source"]).toBe("./src/api/im-rate-source.ts")
    expect(exportsMap["./api/limits-source"]).toBe("./src/api/limits-source.ts")
    expect(exportsMap["./api/shared-memory-adapter"]).toBe("./src/api/shared-memory-adapter.ts")
    expect(exportsMap["./api/auth-provider"]).toBe("./src/api/auth-provider.ts")
    expect(exportsMap["./api/message-renderer"]).toBe("./src/api/message-renderer.ts")
    expect(exportsMap["./api/quick-action"]).toBe("./src/api/quick-action.ts")
    expect(exportsMap["./api/uri-handler"]).toBe("./src/api/uri-handler.ts")
    expect(exportsMap["./api/view-container"]).toBe("./src/api/view-container.ts")
    expect(exportsMap["./api/view"]).toBe("./src/api/view.ts")
    expect(exportsMap["./api/webview"]).toBe("./src/api/webview.ts")
    expect(exportsMap["./api/routing-strategy"]).toBe("./src/api/routing-strategy.ts")
    expect(exportsMap["./api/deployment-filter"]).toBe("./src/api/deployment-filter.ts")
    expect(exportsMap["./api/protocol-adapter"]).toBe("./src/api/protocol-adapter.ts")
    expect(exportsMap["./api/tool-route"]).toBe("./src/api/tool-route.ts")
    expect(exportsMap["./api/terminal-completion"]).toBe("./src/api/terminal-completion.ts")
    expect(exportsMap["./api/command-safety"]).toBe("./src/api/command-safety.ts")
    expect(exportsMap["./api/workspace-backend"]).toBe("./src/api/workspace-backend.ts")
    expect(exportsMap["./api/modal-mount"]).toBe("./src/api/modal-mount.ts")
    expect(exportsMap["./api/tray-item"]).toBe("./src/api/tray-item.ts")
    expect(exportsMap["./api/theme"]).toBe("./src/api/theme.ts")
    expect(exportsMap["./api/theme-pack"]).toBe("./src/api/theme-pack.ts")
    expect(exportsMap["./api/font-contribution"]).toBe("./src/api/font-contribution.ts")
    expect(exportsMap["./api/wallpaper"]).toBe("./src/api/wallpaper.ts")
    expect(exportsMap["./api/density-preset"]).toBe("./src/api/density-preset.ts")
    expect(exportsMap["./api/ai-provider"]).toBe("./src/api/ai-provider.ts")
    expect(exportsMap["./api/providers"]).toBe("./src/api/ai-provider.ts")
    expect(exportsMap["./api/ocr-provider"]).toBe("./src/api/ocr-provider.ts")
    expect(exportsMap["./api/media"]).toBe("./src/api/media.ts")
    expect(exportsMap["./api/canvas"]).toBe("./src/api/canvas.ts")
    expect(exportsMap["./api/automation"]).toBe("./src/api/automation.ts")
    expect(exportsMap["./api/companion"]).toBe("./src/api/companion.ts")
    expect(exportsMap["./api/python"]).toBe("./src/api/python.ts")
    expect(exportsMap["./api/workflow-node"]).toBe("./src/api/workflow-node.ts")
    expect(exportsMap["./api/workflow-trigger"]).toBe("./src/api/workflow-trigger.ts")
    expect(exportsMap["./api/exporter"]).toBe("./src/api/exporter.ts")
    expect(exportsMap["./api/importer"]).toBe("./src/api/importer.ts")
    expect(exportsMap["./api/a2ui-component"]).toBe("./src/api/a2ui-component.ts")
    expect(exportsMap["./api/a2ui-template"]).toBe("./src/api/a2ui-template.ts")
    expect(exportsMap["./api/chat-middleware"]).toBe("./src/api/chat-middleware.ts")
    expect(exportsMap["./api/cli-tool"]).toBe("./src/api/cli-tool.ts")
    expect(exportsMap["./api/command"]).toBe("./src/api/command.ts")
    expect(exportsMap["./api/configuration"]).toBe("./src/api/configuration.ts")
    expect(exportsMap["./api/external-agent-adapter"]).toBe("./src/api/external-agent-adapter.ts")
    expect(exportsMap["./api/external-agent-preset"]).toBe("./src/api/external-agent-preset.ts")
    expect(exportsMap["./api/lsp-server"]).toBe("./src/api/lsp-server.ts")
    expect(exportsMap["./api/mode"]).toBe("./src/api/mode.ts")
    expect(exportsMap["./api/scheduled-task"]).toBe("./src/api/scheduled-task.ts")
    expect(exportsMap["./api/tool"]).toBe("./src/api/tool.ts")
    expect(exportsMap["./api/pet"]).toBe("./src/api/pet.ts")
  })

  it("publishes the define helper family as stable capability subpaths", () => {
    expect(exportsMap["./define/*"]).toBe("./src/define/define-*.ts")
  })

  it("publishes contract metadata for capability and extension-point audits", () => {
    expect(exportsMap["./contracts"]).toBe("./src/contracts/index.ts")
  })

  it("documents every stable package subpath in the README table", () => {
    for (const subpath of Object.keys(exportsMap).sort()) {
      if (subpath === ".") {
        expect(readme).toContain("@cognia/plugin-sdk")
        continue
      }

      if (subpath.includes("*")) {
        expect(readme).toContain("@cognia/plugin-sdk/define/<name>")
        continue
      }

      expect(readme).toContain(`@cognia/plugin-sdk${subpath.slice(1)}`)
    }
  })
})
