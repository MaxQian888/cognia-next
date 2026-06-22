import { defineA2UIComponent } from "./define-a2ui-component"
import { defineA2UITemplate } from "./define-a2ui-template"
import { defineAiProvider } from "./define-ai-provider"
import { defineCliTool } from "./define-cli-tool"
import { defineCommand } from "./define-command"
import { defineLspServer } from "./define-lsp-server"
import { defineMode } from "./define-mode"
import { defineOcrProvider } from "./define-ocr-provider"
import { defineScheduledTask } from "./define-scheduled-task"
import { defineTool } from "./define-tool"
import type {
  A2UIPluginComponentDef,
  A2UITemplateDef,
  PluginLspServerDef,
  PluginManifestCommandDef,
  PluginModeDef,
  PluginScheduledTaskDef,
  PluginToolDef,
} from "@/types/plugin/plugin"
import type { PluginAiProviderDef } from "@/types/plugin/plugin-ai-provider"
import type { PluginCliToolDef } from "@/types/plugin/plugin-cli-tool"
import type { PluginOcrProviderDef } from "@/types/plugin/plugin-ocr"

describe("manifest contribution define helpers", () => {
  it("returns each manifest contribution object by reference", () => {
    const tool: PluginToolDef = {
      name: "summarize_selection",
      description: "Summarize the selected text",
      parametersSchema: { type: "object" },
    }
    const a2uiComponent: A2UIPluginComponentDef = {
      type: "selection-summary",
      name: "Selection summary",
    }
    const a2uiTemplate: A2UITemplateDef = {
      id: "summary-panel",
      name: "Summary panel",
      surfaceType: "panel",
      components: [],
    }
    const aiProvider: PluginAiProviderDef = {
      id: "summarizer",
      label: "Summarizer",
      kind: "llm",
      entry: "./providers/summarizer.ts",
      export: "createProvider",
    }
    const cliTool: PluginCliToolDef = {
      name: "ripgrep_search",
      description: "Search workspace text",
      parameters: { type: "object" },
      binary: { kind: "requires", name: "rg" },
      argv: [{ literal: "--json" }],
    }
    const command: PluginManifestCommandDef = {
      id: "summary.refresh",
      name: "Refresh summary",
    }
    const lspServer: PluginLspServerDef = {
      id: "summary-lsp",
      name: "Summary LSP",
      languages: ["markdown"],
      command: "summary-lsp",
    }
    const mode: PluginModeDef = {
      id: "summarizer",
      name: "Summarizer",
      description: "Summarize selected content",
      icon: "FileText",
    }
    const ocrProvider: PluginOcrProviderDef = {
      id: "summary-ocr",
      label: "Summary OCR",
      entry: "./ocr/provider.ts",
      export: "createProvider",
    }
    const scheduledTask: PluginScheduledTaskDef = {
      name: "refresh-summary-index",
      handler: "refreshSummaryIndex",
      trigger: { type: "interval", seconds: 900 },
    }

    expect(defineTool(tool)).toBe(tool)
    expect(defineA2UIComponent(a2uiComponent)).toBe(a2uiComponent)
    expect(defineA2UITemplate(a2uiTemplate)).toBe(a2uiTemplate)
    expect(defineAiProvider(aiProvider)).toBe(aiProvider)
    expect(defineCliTool(cliTool)).toBe(cliTool)
    expect(defineCommand(command)).toBe(command)
    expect(defineLspServer(lspServer)).toBe(lspServer)
    expect(defineMode(mode)).toBe(mode)
    expect(defineOcrProvider(ocrProvider)).toBe(ocrProvider)
    expect(defineScheduledTask(scheduledTask)).toBe(scheduledTask)
  })
})
