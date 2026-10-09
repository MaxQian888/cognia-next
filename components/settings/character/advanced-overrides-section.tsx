"use client"

/**
 * "Advanced overrides" area of the agent editor: every agent-level override
 * of an app default that `resolveSendOptions` (and the connector binding
 * resolver) honours, in one collapsed section so the common form stays short.
 *
 * Fully controlled over an {@link AgentOverrides} record. Each control writes
 * `undefined` for "inherit" and passes untouched values through by reference,
 * so opening and saving an agent changes nothing it did not show a change for
 * — which is what keeps a variant from starting to own fields it never edited.
 */

import { useTranslations } from "next-intl"

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { OptionalNumberInput } from "@/components/settings/common/optional-number-input"
import { useUtilityProviderOptions } from "@/components/settings/common/model-override-fields"
import { OUTPUT_STYLE_IDS, type OutputStyleId } from "@/lib/claude/output-styles"
import { DEFAULT_CATALOG_ID, getCatalog, getRegisteredCatalogIds } from "@/lib/a2ui/catalog"
import { countAgentOverrides, type AgentOverrides } from "@/lib/agents/agent-overrides"
import { CompactionOverride, parseBoundedInteger } from "./compaction-override"
import { InheritBooleanSelect, InheritSelect } from "./inherit-select"
import { InstructionsOverride } from "./instructions-override"
import { PlatformDefaultsOverride } from "./platform-defaults-override"
import { SandboxPolicyOverride } from "./sandbox-policy-override"
import { ToolFilterOverride } from "./tool-filter-override"
import { ToolSearchOverride } from "./tool-search-override"

/** Bounds of the app-level thinking-budget control (Settings → Agent runtime). */
export const THINKING_BUDGET_MIN = 0
export const THINKING_BUDGET_MAX = 64000

export interface AdvancedOverridesSectionProps {
  value: AgentOverrides
  onChange: (next: AgentOverrides) => void
}

export function AdvancedOverridesSection({ value, onChange }: AdvancedOverridesSectionProps) {
  const t = useTranslations("settings.characters.editor.advanced")
  const count = countAgentOverrides(value)
  return (
    <Accordion type="single" collapsible className="rounded-md border px-3">
      <AccordionItem value="advanced" className="border-b-0">
        <AccordionTrigger className="text-xs font-medium" data-testid="agent-advanced-overrides">
          <span className="flex items-center gap-2">
            {t("title")}
            {count > 0 && (
              <Badge variant="secondary" className="text-[10px]">
                {t("count", { count })}
              </Badge>
            )}
          </span>
        </AccordionTrigger>
        <AccordionContent>
          <AdvancedOverridesFields value={value} onChange={onChange} />
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  )
}

/**
 * The controls themselves. Rendered only while the section is open, so the
 * catalog and provider lookups they need never run for a collapsed editor.
 */
export function AdvancedOverridesFields({ value, onChange }: AdvancedOverridesSectionProps) {
  const t = useTranslations("settings.characters.editor.advanced")
  const tDefaults = useTranslations("settings.agentRuntimeSection.defaults")
  const tA2UIRuntime = useTranslations("settings.a2ui.runtime")
  const providers = useUtilityProviderOptions()

  const set = <K extends keyof AgentOverrides>(key: K, next: AgentOverrides[K]) =>
    onChange({ ...value, [key]: next })

  // The custom instruction is its own override: it applies whenever the
  // EFFECTIVE style is "custom", which an inherited style can be. It is only
  // hidden when this agent pins a different style and holds no text.
  const showCustomStyle =
    value.outputStyle === undefined ||
    value.outputStyle === "custom" ||
    value.customOutputStyle !== undefined

  return (
    <div className="space-y-4 pb-2">
      <p className="text-[10px] text-muted-foreground">{t("description")}</p>

      <section className="space-y-3">
        <h4 className="text-xs font-medium">{t("groups.model")}</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <InheritSelect
            id="agent-override-provider"
            label={t("provider.label")}
            description={t("provider.description")}
            value={value.providerId}
            options={providers.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(next) => set("providerId", next)}
          />
          <div className="space-y-1">
            <Label htmlFor="agent-override-thinking" className="text-xs">
              {t("thinking.label")}
            </Label>
            <OptionalNumberInput
              id="agent-override-thinking"
              min={THINKING_BUDGET_MIN}
              max={THINKING_BUDGET_MAX}
              step={1024}
              inputMode="numeric"
              className="h-8 text-xs"
              placeholder={t("inheritPlaceholder")}
              aria-label={t("thinking.label")}
              value={value.maxThinkingTokens}
              parse={(raw) => parseBoundedInteger(raw, THINKING_BUDGET_MIN, THINKING_BUDGET_MAX)}
              onCommit={(next) => set("maxThinkingTokens", next)}
            />
            <p className="text-[10px] text-muted-foreground">{t("thinking.description")}</p>
          </div>
          <InheritSelect<OutputStyleId>
            id="agent-override-output-style"
            label={t("outputStyle.label")}
            description={t("outputStyle.description")}
            value={value.outputStyle as OutputStyleId | undefined}
            options={OUTPUT_STYLE_IDS.map((id) => ({
              value: id,
              label: tDefaults(`outputStyle.${id}`),
            }))}
            onChange={(next) => set("outputStyle", next)}
          />
          <InheritBooleanSelect
            id="agent-override-a2ui"
            label={t("a2ui.label")}
            description={t("a2ui.description")}
            value={value.a2uiEnabled}
            onChange={(next) => set("a2uiEnabled", next)}
          />
          <InheritSelect
            id="agent-override-a2ui-catalog"
            label={t("a2uiCatalog.label")}
            description={t("a2uiCatalog.description")}
            value={value.a2uiCatalogId}
            options={getRegisteredCatalogIds().map((id) => ({
              value: id,
              label:
                id === DEFAULT_CATALOG_ID
                  ? tA2UIRuntime("global.standardCatalog")
                  : (getCatalog(id)?.name ?? id),
            }))}
            onChange={(next) => set("a2uiCatalogId", next)}
          />
        </div>
        {showCustomStyle && (
          <div className="space-y-1">
            <Label htmlFor="agent-override-custom-style" className="text-xs">
              {t("outputStyle.customLabel")}
            </Label>
            <Textarea
              id="agent-override-custom-style"
              rows={2}
              value={value.customOutputStyle ?? ""}
              onChange={(e) =>
                set("customOutputStyle", e.target.value.trim() ? e.target.value : undefined)
              }
              placeholder={t("outputStyle.customPlaceholder")}
              className="text-xs"
            />
            <p className="text-[10px] text-muted-foreground">{t("outputStyle.customHint")}</p>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h4 className="text-xs font-medium">{t("groups.tools")}</h4>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <InheritBooleanSelect
            id="agent-override-plugin-tools"
            label={t("pluginTools.label")}
            description={t("pluginTools.description")}
            inheritLabel={t("pluginTools.default")}
            // Stored inverted: `disablePluginTools: true` removes the tools.
            value={value.disablePluginTools === undefined ? undefined : !value.disablePluginTools}
            onChange={(next) => set("disablePluginTools", next === undefined ? undefined : !next)}
          />
          <InheritBooleanSelect
            id="agent-override-built-in-skills"
            label={t("builtInSkills.label")}
            description={t("builtInSkills.description")}
            inheritLabel={t("builtInSkills.default")}
            value={value.enableBuiltInSkills}
            onChange={(next) => set("enableBuiltInSkills", next)}
          />
          <InheritBooleanSelect
            id="agent-override-ocr"
            label={t("ocr.label")}
            description={t("ocr.description")}
            inheritLabel={t("ocr.default")}
            value={value.enableOcr}
            onChange={(next) => set("enableOcr", next)}
          />
        </div>
        <ToolFilterOverride value={value.toolFilter} onChange={(next) => set("toolFilter", next)} />
        <ToolSearchOverride
          value={value.toolSearchRuntimeOverride}
          onChange={(next) => set("toolSearchRuntimeOverride", next)}
        />
      </section>

      <section className="space-y-3">
        <h4 className="text-xs font-medium">{t("groups.context")}</h4>
        <CompactionOverride
          value={value.compactionOverride}
          onChange={(next) => set("compactionOverride", next)}
        />
        <InstructionsOverride
          value={value.instructionsOverride}
          onChange={(next) => set("instructionsOverride", next)}
        />
      </section>

      <section className="space-y-3">
        <h4 className="text-xs font-medium">{t("groups.safety")}</h4>
        <InheritBooleanSelect
          id="agent-override-workspace-confinement"
          label={t("workspaceConfinement.label")}
          description={t("workspaceConfinement.description")}
          value={value.workspaceConfinementEnabled}
          onChange={(next) => set("workspaceConfinementEnabled", next)}
        />
        <SandboxPolicyOverride
          value={value.sandboxPolicy}
          onChange={(next) => set("sandboxPolicy", next)}
        />
      </section>

      <section className="space-y-3">
        <h4 className="text-xs font-medium">{t("groups.platforms")}</h4>
        <PlatformDefaultsOverride
          value={value.platformDefaults}
          onChange={(next) => set("platformDefaults", next)}
        />
      </section>
    </div>
  )
}
