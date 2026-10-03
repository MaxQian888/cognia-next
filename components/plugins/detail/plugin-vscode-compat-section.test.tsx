/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import type { PluginManifest } from "@/types/plugin"
import type {
  VsCodeExtensionBlock,
  VsCodeUnsupportedContribution,
} from "@/types/plugin/plugin-vscode"
import messages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import { PluginVscodeCompatSection } from "./plugin-vscode-compat-section"

const ALL: VsCodeUnsupportedContribution[] = [
  "esm-bundle",
  "debuggers",
  "notebooks",
  "views",
  "menus",
  "keybindings",
  "editor-grammars",
  "extension-pack",
]

function manifest(block: Partial<VsCodeExtensionBlock>, type = "vscode-extension"): PluginManifest {
  return {
    id: "acme.ext",
    type,
    vscodeExtension: {
      identifier: "acme.ext",
      version: "1.0.0",
      engineVscode: "^1.91.0",
      vsixSha256: "a".repeat(64),
      source: "openvsx",
      bundleFormat: "cjs",
      activationEvents: [],
      ...block,
    },
  } as unknown as PluginManifest
}

function renderSection(m: PluginManifest) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PluginVscodeCompatSection manifest={m} />
    </NextIntlClientProvider>
  )
}

describe("PluginVscodeCompatSection", () => {
  it("renders nothing when the extension uses nothing Cognia lacks", () => {
    const { container } = renderSection(manifest({}))
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing for other plugin types", () => {
    const { container } = renderSection(
      manifest({ unsupportedContributions: ["menus"] }, "frontend")
    )
    expect(container).toBeEmptyDOMElement()
  })

  it("labels every unsupported contribution", () => {
    renderSection(manifest({ unsupportedContributions: ALL }))
    expect(screen.getByTestId("plugin-vscode-compat-section")).toHaveTextContent(
      "Not available in Cognia"
    )
    for (const kind of ALL) {
      expect(screen.getByTestId(`plugin-vscode-compat-${kind}`).textContent?.trim()).not.toBe("")
    }
    expect(screen.getByTestId("plugin-vscode-compat-esm-bundle")).toHaveTextContent(
      "ES module. The extension is an ES module."
    )
    expect(screen.getByTestId("plugin-vscode-compat-editor-grammars")).toHaveTextContent(
      /not in the code editor/
    )
  })

  it("has every label in Chinese too", () => {
    // The test runtime resolves English only, so the Chinese bundle is read directly.
    const zh = (zhMessages as { plugins: { vscodeCompat: Record<string, unknown> } }).plugins
      .vscodeCompat as {
      title: string
      contributions: Record<string, { title: string; description: string }>
    }
    expect(zh.title).toBe("Cognia 中不可用")
    const keys = Object.keys(
      (messages as { plugins: { vscodeCompat: { contributions: object } } }).plugins.vscodeCompat
        .contributions
    )
    expect(keys).toHaveLength(ALL.length)
    for (const key of keys) {
      expect(zh.contributions[key]?.title).toBeTruthy()
      expect(zh.contributions[key]?.description).toBeTruthy()
    }
  })

  it("lists the unsupported APIs and activation events by name", () => {
    renderSection(
      manifest({
        unsupportedApis: ["vscode.debug", "vscode.window.createTreeView"],
        unsupportedActivationEvents: ["onDebug"],
      })
    )
    const apis = screen.getByTestId("plugin-vscode-compat-apis")
    expect(within(apis).getByText("vscode.debug")).toBeInTheDocument()
    expect(within(apis).getByText("vscode.window.createTreeView")).toBeInTheDocument()
    expect(apis).toHaveTextContent(/can miss calls in minified code/)
    const activation = screen.getByTestId("plugin-vscode-compat-activation")
    expect(within(activation).getByText("onDebug")).toBeInTheDocument()
  })

  it("skips values a newer or damaged record holds that it does not know", () => {
    const { container } = renderSection(
      manifest({ unsupportedContributions: ["telepathy" as never], unsupportedApis: [42 as never] })
    )
    expect(container).toBeEmptyDOMElement()
  })
})
