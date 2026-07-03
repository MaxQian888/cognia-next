"use client"

/**
 * Canvas Settings — eight tabs that mirror the full Cognia
 * `CanvasSettings` shape: Editor / AI / Versioning / Collaboration /
 * Execution / Accessibility / Keybindings / Theme. Every field on
 * `@/types/canvas/settings` has a control here — no omissions.
 */

import { useTranslations } from "next-intl"
import { useTheme } from "next-themes"
import { useState } from "react"
import { PencilRuler, RotateCcw } from "lucide-react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { useKeybindingStore } from "@/stores/canvas/keybinding-store"
import type { CanvasSettings } from "@/types/canvas/settings"
import { isTauri } from "@/lib/tauri"
import { KeybindingSettings } from "@/components/canvas/keybinding-settings"

export function CanvasSection() {
  const t = useTranslations("settings.canvas")
  const settings = useCanvasSettingsStore((s) => s.settings)
  const resetSection = useCanvasSettingsStore((s) => s.resetSection)
  const resetAll = useCanvasSettingsStore((s) => s.resetSettings)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label className="flex items-center gap-2 text-base font-semibold">
            <PencilRuler className="size-4" />
            {t("title", { default: "Canvas" })}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t("description", {
              default:
                "Configure the Monaco-based code/document editor — fonts, AI suggestions, versioning, collaboration, sandbox execution, accessibility, and keybindings.",
            })}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => resetAll()} className="gap-1">
          <RotateCcw className="size-3.5" />
          {t("resetAll", { default: "Reset all" })}
        </Button>
      </div>

      <Tabs defaultValue="editor" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4 lg:grid-cols-8">
          <TabsTrigger value="editor">{t("tabs.editor", { default: "Editor" })}</TabsTrigger>
          <TabsTrigger value="ai">{t("tabs.ai", { default: "AI" })}</TabsTrigger>
          <TabsTrigger value="version">{t("tabs.version", { default: "Versioning" })}</TabsTrigger>
          <TabsTrigger value="collab">{t("tabs.collab", { default: "Collab" })}</TabsTrigger>
          <TabsTrigger value="execution">
            {t("tabs.execution", { default: "Execution" })}
          </TabsTrigger>
          <TabsTrigger value="a11y">{t("tabs.a11y", { default: "Accessibility" })}</TabsTrigger>
          <TabsTrigger value="keys">{t("tabs.keys", { default: "Keybindings" })}</TabsTrigger>
          <TabsTrigger value="theme">{t("tabs.theme", { default: "Theme" })}</TabsTrigger>
        </TabsList>

        <TabsContent value="editor" className="m-0">
          <EditorTab settings={settings} />
          <ResetTabFooter onReset={() => resetSection("editor")} />
        </TabsContent>
        <TabsContent value="ai" className="m-0">
          <AITab settings={settings} />
          <ResetTabFooter onReset={() => resetSection("ai")} />
        </TabsContent>
        <TabsContent value="version" className="m-0">
          <VersionTab settings={settings} />
          <ResetTabFooter onReset={() => resetSection("version")} />
        </TabsContent>
        <TabsContent value="collab" className="m-0">
          <CollaborationTab settings={settings} />
          <ResetTabFooter onReset={() => resetSection("collaboration")} />
        </TabsContent>
        <TabsContent value="execution" className="m-0">
          <ExecutionTab settings={settings} />
          <ResetTabFooter onReset={() => resetSection("execution")} />
        </TabsContent>
        <TabsContent value="a11y" className="m-0">
          <AccessibilityTab settings={settings} />
          <ResetTabFooter onReset={() => resetSection("accessibility")} />
        </TabsContent>
        <TabsContent value="keys" className="m-0">
          <KeybindingsTab />
          {/* Reset the real keybinding store (the settings object has no
              keybindings field — the live bindings live in useKeybindingStore). */}
          <ResetTabFooter onReset={() => useKeybindingStore.getState().resetAllBindings()} />
        </TabsContent>
        <TabsContent value="theme" className="m-0">
          <ThemeTab settings={settings} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ResetTabFooter({ onReset }: { onReset: () => void }) {
  const t = useTranslations("settings.canvas")
  return (
    <div className="mt-6 flex justify-end border-t pt-3">
      <Button variant="ghost" size="sm" onClick={onReset} className="gap-1 text-xs">
        <RotateCcw className="size-3" />
        {t("resetTab", { default: "Reset this tab" })}
      </Button>
    </div>
  )
}

interface SectionProps {
  settings: CanvasSettings
}

/* ------- Editor tab ------- */

function EditorTab({ settings }: SectionProps) {
  const t = useTranslations("settings.canvas.editor")
  const update = useCanvasSettingsStore((s) => s.updateEditorSettings)
  const e = settings.editor
  return (
    <div className="space-y-5">
      <SliderRow
        label={t("fontSize")}
        value={e.fontSize}
        min={8}
        max={72}
        step={1}
        unit="px"
        onChange={(v) => update({ fontSize: v })}
      />
      <Row label={t("fontFamily")}>
        <Select value={e.fontFamily} onValueChange={(v) => update({ fontFamily: v })}>
          <SelectTrigger className="w-full max-w-md text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace">
              {t("fontFamilyOptions.firaCode")}
            </SelectItem>
            <SelectItem value="'JetBrains Mono', monospace">
              {t("fontFamilyOptions.jetbrainsMono")}
            </SelectItem>
            <SelectItem value="'Cascadia Code', monospace">
              {t("fontFamilyOptions.cascadiaCode")}
            </SelectItem>
            <SelectItem value="'Source Code Pro', monospace">
              {t("fontFamilyOptions.sourceCodePro")}
            </SelectItem>
            <SelectItem value="'IBM Plex Mono', monospace">
              {t("fontFamilyOptions.ibmPlexMono")}
            </SelectItem>
            <SelectItem value="ui-monospace, SFMono-Regular, monospace">
              {t("fontFamilyOptions.systemMonospace")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Toggle
        label={t("fontLigatures")}
        checked={e.fontLigatures}
        onChange={(v) => update({ fontLigatures: v })}
      />
      <SliderRow
        label={t("letterSpacing")}
        value={e.letterSpacing}
        min={-3}
        max={8}
        step={0.5}
        unit="px"
        onChange={(v) => update({ letterSpacing: v })}
      />
      <SliderRow
        label={t("lineHeight")}
        value={e.lineHeight}
        min={1}
        max={3}
        step={0.05}
        onChange={(v) => update({ lineHeight: v })}
      />
      <SliderRow
        label={t("tabSize")}
        value={e.tabSize}
        min={1}
        max={8}
        step={1}
        onChange={(v) => update({ tabSize: v })}
      />
      <Toggle
        label={t("insertSpaces")}
        checked={e.insertSpaces}
        onChange={(v) => update({ insertSpaces: v })}
      />
      <Toggle
        label={t("wordWrap")}
        checked={e.wordWrap}
        onChange={(v) => update({ wordWrap: v })}
      />
      <Toggle label={t("minimap")} checked={e.minimap} onChange={(v) => update({ minimap: v })} />
      {e.minimap && (
        <SliderRow
          label={t("minimapScale")}
          value={e.minimapScale}
          min={1}
          max={3}
          step={1}
          unit="x"
          onChange={(v) => update({ minimapScale: v })}
        />
      )}
      <Row label={t("lineNumbers")}>
        <Select
          value={e.lineNumbers}
          onValueChange={(v) => update({ lineNumbers: v as typeof e.lineNumbers })}
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="on">{t("lineNumbersOptions.on")}</SelectItem>
            <SelectItem value="off">{t("lineNumbersOptions.off")}</SelectItem>
            <SelectItem value="relative">{t("lineNumbersOptions.relative")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("renderWhitespace")}>
        <Select
          value={e.renderWhitespace}
          onValueChange={(v) => update({ renderWhitespace: v as typeof e.renderWhitespace })}
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("renderWhitespaceOptions.none")}</SelectItem>
            <SelectItem value="boundary">{t("renderWhitespaceOptions.boundary")}</SelectItem>
            <SelectItem value="selection">{t("renderWhitespaceOptions.selection")}</SelectItem>
            <SelectItem value="trailing">{t("renderWhitespaceOptions.trailing")}</SelectItem>
            <SelectItem value="all">{t("renderWhitespaceOptions.all")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("renderLineHighlight")}>
        <Select
          value={e.renderLineHighlight}
          onValueChange={(v) => update({ renderLineHighlight: v as typeof e.renderLineHighlight })}
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["none", "gutter", "line", "all"] as const).map((v) => (
              <SelectItem key={v} value={v}>
                {t(`renderLineHighlightOptions.${v}` as Parameters<typeof t>[0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Toggle
        label={t("scrollBeyondLastLine")}
        checked={e.scrollBeyondLastLine}
        onChange={(v) => update({ scrollBeyondLastLine: v })}
      />
      <Toggle
        label={t("stickyScroll")}
        checked={e.stickyScroll}
        onChange={(v) => update({ stickyScroll: v })}
      />
      {e.stickyScroll && (
        <SliderRow
          label={t("stickyScrollMaxLines")}
          value={e.stickyScrollMaxLines}
          min={1}
          max={10}
          step={1}
          onChange={(v) => update({ stickyScrollMaxLines: v })}
        />
      )}
      <Toggle label={t("folding")} checked={e.folding} onChange={(v) => update({ folding: v })} />
      {e.folding && (
        <Row label={t("showFoldingControls")}>
          <Select
            value={e.showFoldingControls}
            onValueChange={(v) =>
              update({ showFoldingControls: v as typeof e.showFoldingControls })
            }
          >
            <SelectTrigger className="w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">{t("showFoldingControlsOptions.always")}</SelectItem>
              <SelectItem value="mouseover">{t("showFoldingControlsOptions.mouseover")}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      )}
      <Toggle
        label={t("inlineSuggest")}
        checked={e.inlineSuggest}
        onChange={(v) => update({ inlineSuggest: v })}
      />
      <Toggle
        label={t("autoClosingBrackets")}
        checked={e.autoClosingBrackets}
        onChange={(v) => update({ autoClosingBrackets: v })}
      />
      <Toggle
        label={t("autoClosingQuotes")}
        checked={e.autoClosingQuotes}
        onChange={(v) => update({ autoClosingQuotes: v })}
      />
      <Toggle
        label={t("formatOnPaste")}
        checked={e.formatOnPaste}
        onChange={(v) => update({ formatOnPaste: v })}
      />
      <Toggle
        label={t("formatOnType")}
        checked={e.formatOnType}
        onChange={(v) => update({ formatOnType: v })}
      />
      <Row label={t("cursorBlinking")}>
        <Select
          value={e.cursorBlinking}
          onValueChange={(v) => update({ cursorBlinking: v as typeof e.cursorBlinking })}
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["blink", "smooth", "phase", "expand", "solid"] as const).map((v) => (
              <SelectItem key={v} value={v}>
                {t(`cursorBlinkingOptions.${v}` as Parameters<typeof t>[0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("cursorStyle")}>
        <Select
          value={e.cursorStyle}
          onValueChange={(v) => update({ cursorStyle: v as typeof e.cursorStyle })}
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["line", "block", "underline"] as const).map((v) => (
              <SelectItem key={v} value={v}>
                {t(`cursorStyleOptions.${v}` as Parameters<typeof t>[0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("cursorSmoothCaretAnimation")}>
        <Select
          value={e.cursorSmoothCaretAnimation}
          onValueChange={(v) =>
            update({ cursorSmoothCaretAnimation: v as typeof e.cursorSmoothCaretAnimation })
          }
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["off", "explicit", "on"] as const).map((v) => (
              <SelectItem key={v} value={v}>
                {t(`cursorSmoothCaretAnimationOptions.${v}` as Parameters<typeof t>[0])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Toggle
        label={t("smoothScrolling")}
        checked={e.smoothScrolling}
        onChange={(v) => update({ smoothScrolling: v })}
      />
      <Toggle
        label={t("mouseWheelZoom")}
        checked={e.mouseWheelZoom}
        onChange={(v) => update({ mouseWheelZoom: v })}
      />
      <Toggle
        label={t("bracketPairColorization")}
        checked={e.bracketPairColorization}
        onChange={(v) => update({ bracketPairColorization: v })}
      />
      <SliderRow
        label={t("paddingTop")}
        value={e.padding.top}
        min={0}
        max={40}
        step={1}
        unit="px"
        onChange={(v) => update({ padding: { ...e.padding, top: v } })}
      />
      <SliderRow
        label={t("paddingBottom")}
        value={e.padding.bottom}
        min={0}
        max={40}
        step={1}
        unit="px"
        onChange={(v) => update({ padding: { ...e.padding, bottom: v } })}
      />
      <Separator />
      <Toggle
        label={t("indentationGuides")}
        checked={e.guides.indentation}
        onChange={(v) => update({ guides: { ...e.guides, indentation: v } })}
      />
      <Toggle
        label={t("bracketPairGuides")}
        checked={e.guides.bracketPairs}
        onChange={(v) => update({ guides: { ...e.guides, bracketPairs: v } })}
      />
    </div>
  )
}

/* ------- AI tab ------- */

function AITab({ settings }: SectionProps) {
  const t = useTranslations("settings.canvas.ai")
  const update = useCanvasSettingsStore((s) => s.updateAISettings)
  const a = settings.ai
  return (
    <div className="space-y-5">
      <Toggle
        label={t("autoSuggestions")}
        checked={a.autoSuggestions}
        onChange={(v) => update({ autoSuggestions: v })}
      />
      <SliderRow
        label={t("suggestionDelay")}
        value={a.suggestionDelay}
        min={100}
        max={5000}
        step={50}
        unit="ms"
        onChange={(v) => update({ suggestionDelay: v })}
      />
      <SliderRow
        label={t("maxSuggestions")}
        value={a.maxSuggestions}
        min={1}
        max={20}
        step={1}
        onChange={(v) => update({ maxSuggestions: v })}
      />
      <Toggle
        label={t("streamingResponses")}
        checked={a.streamingResponses}
        onChange={(v) => update({ streamingResponses: v })}
      />
      <SliderRow
        label={t("contextLines")}
        value={a.contextLines}
        min={1}
        max={200}
        step={1}
        onChange={(v) => update({ contextLines: v })}
      />
      <Row label={t("suggestionProvider")}>
        <Select
          value={a.suggestionProvider}
          onValueChange={(v) => update({ suggestionProvider: v as typeof a.suggestionProvider })}
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{t("suggestionProviderOptions.default")}</SelectItem>
            <SelectItem value="custom">{t("suggestionProviderOptions.custom")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      {a.suggestionProvider === "custom" && (
        <Row label={t("customProviderUrl")}>
          <Input
            className="max-w-md text-xs"
            value={a.customProviderUrl ?? ""}
            placeholder="https://api.example.com/v1"
            onChange={(e) => update({ customProviderUrl: e.target.value })}
          />
        </Row>
      )}
      <Toggle
        label={t("enableInlineCompletion")}
        checked={a.enableInlineCompletion}
        onChange={(v) => update({ enableInlineCompletion: v })}
      />
      <Toggle
        label={t("showConfidence")}
        checked={a.showConfidence}
        onChange={(v) => update({ showConfidence: v })}
      />
    </div>
  )
}

/* ------- Versioning tab ------- */

function VersionTab({ settings }: SectionProps) {
  const t = useTranslations("settings.canvas.version")
  const update = useCanvasSettingsStore((s) => s.updateVersionSettings)
  const v = settings.version
  return (
    <div className="space-y-5">
      <SliderRow
        label={t("autoSaveInterval")}
        value={v.autoSaveInterval}
        min={10}
        max={300}
        step={5}
        unit="s"
        onChange={(n) => update({ autoSaveInterval: n })}
      />
      <SliderRow
        label={t("maxVersions")}
        value={v.maxVersions}
        min={5}
        max={200}
        step={1}
        onChange={(n) => update({ maxVersions: n })}
      />
      <Toggle
        label={t("compressOldVersions")}
        checked={v.compressOldVersions}
        onChange={(b) => update({ compressOldVersions: b })}
      />
      <Toggle
        label={t("keepNamedVersions")}
        checked={v.keepNamedVersions}
        onChange={(b) => update({ keepNamedVersions: b })}
      />
      <Row label={t("diffViewMode")}>
        <Select
          value={v.diffViewMode}
          onValueChange={(val) => update({ diffViewMode: val as typeof v.diffViewMode })}
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inline">{t("diffViewModeOptions.inline")}</SelectItem>
            <SelectItem value="side-by-side">{t("diffViewModeOptions.sideBySide")}</SelectItem>
            <SelectItem value="unified">{t("diffViewModeOptions.unified")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Toggle
        label={t("showVersionTimestamps")}
        checked={v.showVersionTimestamps}
        onChange={(b) => update({ showVersionTimestamps: b })}
      />
    </div>
  )
}

/* ------- Collaboration tab ------- */

function CollaborationTab({ settings }: SectionProps) {
  const t = useTranslations("settings.canvas.collab")
  const set = useCanvasSettingsStore((s) => s.updateSettings)
  const c = settings.collaboration
  return (
    <div className="space-y-5">
      <Toggle
        label={t("enableCollaboration")}
        checked={c.enabled}
        onChange={(v) => set({ collaboration: { ...c, enabled: v } })}
      />
      <Row label={t("signallingServerUrl")}>
        <Input
          value={c.serverUrl}
          placeholder="ws://localhost:8787"
          className="max-w-md text-xs"
          onChange={(e) => set({ collaboration: { ...c, serverUrl: e.target.value } })}
        />
      </Row>
      <Toggle
        label={t("showCursors")}
        checked={c.showCursors}
        onChange={(v) => set({ collaboration: { ...c, showCursors: v } })}
      />
      <Toggle
        label={t("showAvatars")}
        checked={c.showAvatars}
        onChange={(v) => set({ collaboration: { ...c, showAvatars: v } })}
      />
      <Toggle
        label={t("showSelections")}
        checked={c.showSelections}
        onChange={(v) => set({ collaboration: { ...c, showSelections: v } })}
      />
      <Toggle
        label={t("cursorSmoothing")}
        checked={c.cursorSmoothing}
        onChange={(v) => set({ collaboration: { ...c, cursorSmoothing: v } })}
      />
      <SliderRow
        label={t("presenceTimeout")}
        value={c.presenceTimeout}
        min={5000}
        max={300000}
        step={1000}
        unit="ms"
        onChange={(n) => set({ collaboration: { ...c, presenceTimeout: n } })}
      />
      <SliderRow
        label={t("syncInterval")}
        value={c.syncInterval}
        min={50}
        max={1000}
        step={10}
        unit="ms"
        onChange={(n) => set({ collaboration: { ...c, syncInterval: n } })}
      />
    </div>
  )
}

/* ------- Execution tab ------- */

function ExecutionTab({ settings }: SectionProps) {
  const t = useTranslations("settings.canvas.execution")
  const set = useCanvasSettingsStore((s) => s.updateSettings)
  const e = settings.execution
  const desktop = isTauri()
  return (
    <div className="space-y-5">
      <Toggle
        label={t("autoExecute")}
        checked={e.autoExecute}
        onChange={(v) => set({ execution: { ...e, autoExecute: v } })}
      />
      <SliderRow
        label={t("maxExecutionTime")}
        value={e.maxExecutionTime}
        min={1000}
        max={60000}
        step={500}
        unit="ms"
        onChange={(v) => set({ execution: { ...e, maxExecutionTime: v } })}
      />
      <Toggle
        label={t("showOutput")}
        checked={e.showOutput}
        onChange={(v) => set({ execution: { ...e, showOutput: v } })}
      />
      <Toggle
        label={t("clearOutputOnRun")}
        checked={e.clearOutputOnRun}
        onChange={(v) => set({ execution: { ...e, clearOutputOnRun: v } })}
      />
      <Toggle
        label={t("preserveVariables")}
        checked={e.preserveVariables}
        onChange={(v) => set({ execution: { ...e, preserveVariables: v } })}
      />
      <Row label={t("sandboxMode")}>
        <Select
          value={e.sandboxMode}
          onValueChange={(v) =>
            set({ execution: { ...e, sandboxMode: v as typeof e.sandboxMode } })
          }
        >
          <SelectTrigger className="w-48 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="strict">{t("sandboxModeOptions.strict")}</SelectItem>
            <SelectItem value="permissive">{t("sandboxModeOptions.permissive")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("pythonRuntime")}>
        <Select
          value={e.pythonRuntime}
          onValueChange={(v) =>
            set({ execution: { ...e, pythonRuntime: v as typeof e.pythonRuntime } })
          }
          disabled={!desktop}
        >
          <SelectTrigger className="w-full text-xs sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{t("pythonRuntimeOptions.none")}</SelectItem>
            <SelectItem value="tauri-sidecar">{t("pythonRuntimeOptions.tauriSidecar")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      {!desktop && <p className="text-xs text-muted-foreground">{t("pythonRequiresDesktop")}</p>}
    </div>
  )
}

/* ------- Accessibility tab ------- */

function AccessibilityTab({ settings }: SectionProps) {
  const t = useTranslations("settings.canvas.a11y")
  const set = useCanvasSettingsStore((s) => s.updateSettings)
  const a = settings.accessibility
  return (
    <div className="space-y-5">
      <Toggle
        label={t("screenReaderOptimized")}
        description={t("screenReaderOptimizedDesc")}
        checked={a.screenReaderOptimized}
        onChange={(v) => set({ accessibility: { ...a, screenReaderOptimized: v } })}
      />
      <Toggle
        label={t("highContrast")}
        description={t("highContrastDesc")}
        checked={a.highContrast}
        onChange={(v) => set({ accessibility: { ...a, highContrast: v } })}
      />
      <Toggle
        label={t("reducedMotion")}
        description={t("reducedMotionDesc")}
        checked={a.reducedMotion}
        onChange={(v) => set({ accessibility: { ...a, reducedMotion: v } })}
      />
      <Toggle
        label={t("focusIndicator")}
        description={t("focusIndicatorDesc")}
        checked={a.focusIndicator}
        onChange={(v) => set({ accessibility: { ...a, focusIndicator: v } })}
      />
      <Toggle
        label={t("announceErrors")}
        description={t("announceErrorsDesc")}
        checked={a.announceErrors}
        onChange={(v) => set({ accessibility: { ...a, announceErrors: v } })}
      />
    </div>
  )
}

/* ------- Keybindings tab ------- */

function KeybindingsTab() {
  return (
    <div className="space-y-3">
      <KeybindingSettings />
    </div>
  )
}

/* ------- Theme tab ------- */

function ThemeTab({ settings }: SectionProps) {
  const set = useCanvasSettingsStore((s) => s.updateSettings)
  const { resolvedTheme } = useTheme()
  const [followSystem, setFollowSystem] = useState(settings.theme === "auto")
  const t = useTranslations("settings.canvas.theme")

  return (
    <div className="space-y-5">
      <Toggle
        label={t("followSystem", { default: "Follow system theme" })}
        checked={followSystem}
        onChange={(v) => {
          setFollowSystem(v)
          set({ theme: v ? "auto" : resolvedTheme === "dark" ? "vs-dark" : "vs" })
        }}
      />
      <Row label={t("monacoTheme", { default: "Monaco theme" })}>
        <Select
          value={settings.theme}
          onValueChange={(v) => {
            setFollowSystem(v === "auto")
            set({ theme: v })
          }}
        >
          <SelectTrigger className="w-full text-xs sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("monacoThemeOptions.auto")}</SelectItem>
            <SelectItem value="vs">{t("monacoThemeOptions.vs")}</SelectItem>
            <SelectItem value="vs-dark">{t("monacoThemeOptions.vsDark")}</SelectItem>
            <SelectItem value="hc-light">{t("monacoThemeOptions.hcLight")}</SelectItem>
            <SelectItem value="hc-black">{t("monacoThemeOptions.hcBlack")}</SelectItem>
          </SelectContent>
        </Select>
      </Row>
      <p className="text-xs text-muted-foreground">
        {t("hint", {
          default:
            "Custom Monaco themes registered through the canvas plugin API will appear in this list at runtime.",
        })}
        <Badge variant="outline" className="ml-2 text-[10px]">
          experimental
        </Badge>
      </p>
    </div>
  )
}

/* ------- shared atoms ------- */

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <Label className="text-xs">{label}</Label>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-md border bg-muted/10 p-3">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-xs">{label}</Label>
        {description && <p className="text-[11px] text-muted-foreground">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {value}
          {unit ? ` ${unit}` : ""}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(v[0])}
      />
    </div>
  )
}
