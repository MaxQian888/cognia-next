"use client"

/**
 * The half of a template definition the Studio could never fill in.
 *
 * `TemplateDefinitionEnvelope` carries eight fields beyond name, description,
 * payload and inputs: `metadata.tags`, `.category`, `.author`, `.icon`,
 * `.localized`, plus `dependencies`, `capabilities` and `compatibility`. All
 * eight are hashed into the content hash, all eight travel in an exported
 * package, and three of them gate instantiation:
 *
 *  - `compatibility.platforms` is a hard blocker in `service.preflight`
 *    (`platform.unsupported`), and `createDraft` hard-coded all three, so a
 *    desktop-only template could not say so.
 *  - `compatibility.min/maxHostVersion` produce `host-version.unsupported`.
 *  - `dependencies` produce `dependency.required-missing` (blocker) or
 *    `dependency.optional-fallback` (warning).
 *  - `capabilities` are checked by the plugin templates API, which maps each
 *    name onto a plugin permission and refuses a plan whose permissions the
 *    calling plugin was not granted.
 *
 * Every one of them was reachable only by editing a definition outside the app
 * and importing it back, which is the shape of an authoring gap rather than a
 * deliberate omission.
 */

import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { MultiEntityPicker } from "@/components/workflow/editor/inspector/forms/shared/multi-entity-picker"
import { locales } from "@/i18n/config"
import type {
  TemplateCompatibility,
  TemplateDependency,
  TemplateMetadata,
  TemplatePlatform,
} from "@/lib/templates/contracts"

/** The editable slice. `name` and `description` stay with the draft editor. */
export interface TemplateMetadataDraft {
  metadata: Omit<TemplateMetadata, "name" | "description">
  dependencies: TemplateDependency[]
  capabilities: string[]
  compatibility: TemplateCompatibility
}

const PLATFORMS: TemplatePlatform[] = ["desktop", "web", "mobile"]

const DEPENDENCY_KINDS: TemplateDependency["kind"][] = [
  "template",
  "plugin",
  "skill",
  "tool",
  "model",
  "provider",
  "connector",
]

const DEPENDENCY_FALLBACKS: NonNullable<TemplateDependency["fallback"]>[] = ["omit", "default"]

/**
 * The capability names `lib/plugin/api/templates-api.ts` knows how to map onto
 * a plugin permission. Free entry stays open because that mapping falls through
 * to the raw permission string (`database:read` and friends) for anything it
 * does not recognise, so the set is a shortlist rather than a closed vocabulary.
 */
const KNOWN_CAPABILITIES = ["filesystem", "network", "twin", "execution", "tool"]

export interface TemplateMetadataEditorProps {
  value: TemplateMetadataDraft
  onChange: (next: TemplateMetadataDraft) => void
}

export function TemplateMetadataEditor({ value, onChange }: TemplateMetadataEditorProps) {
  const t = useTranslations("templateStudio.metadata")
  const { metadata, dependencies, capabilities, compatibility } = value

  const patchMetadata = (patch: Partial<TemplateMetadataDraft["metadata"]>) =>
    onChange({ ...value, metadata: { ...metadata, ...patch } })

  const patchCompatibility = (patch: Partial<TemplateCompatibility>) =>
    onChange({ ...value, compatibility: { ...compatibility, ...patch } })

  const patchDependency = (index: number, patch: Partial<TemplateDependency>) =>
    onChange({
      ...value,
      dependencies: dependencies.map((dependency, i) =>
        i === index ? { ...dependency, ...patch } : dependency
      ),
    })

  const localizedEntries = Object.entries(metadata.localized ?? {})

  const patchLocalized = (locale: string, patch: { name?: string; description?: string }) => {
    const current = metadata.localized?.[locale] ?? { name: "" }
    patchMetadata({
      localized: { ...(metadata.localized ?? {}), [locale]: { ...current, ...patch } },
    })
  }

  const removeLocalized = (locale: string) => {
    const next = { ...(metadata.localized ?? {}) }
    delete next[locale]
    patchMetadata({ localized: Object.keys(next).length > 0 ? next : undefined })
  }

  /** Locales the catalogue ships that this definition has not translated yet. */
  const untranslated = locales.filter((locale) => !(locale in (metadata.localized ?? {})))

  return (
    <div className="space-y-4" data-testid="template-metadata-editor">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="template-category">{t("category")}</Label>
          <Input
            id="template-category"
            className="h-8"
            value={metadata.category ?? ""}
            onChange={(event) => patchMetadata({ category: event.target.value || undefined })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="template-author">{t("author")}</Label>
          <Input
            id="template-author"
            className="h-8"
            value={metadata.author ?? ""}
            onChange={(event) => patchMetadata({ author: event.target.value || undefined })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="template-icon">{t("icon")}</Label>
          <Input
            id="template-icon"
            className="h-8"
            placeholder={t("iconHint")}
            value={metadata.icon ?? ""}
            onChange={(event) => patchMetadata({ icon: event.target.value || undefined })}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="template-tags">{t("tags")}</Label>
        <MultiEntityPicker
          id="template-tags"
          value={metadata.tags ?? []}
          onChange={(next) => patchMetadata({ tags: next.length > 0 ? next : undefined })}
          options={[]}
          emptyHint={t("tagsHint")}
        />
      </div>

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium">{t("compatibility")}</legend>
        <p className="text-xs text-muted-foreground">{t("compatibilityHint")}</p>
        <div className="flex flex-wrap gap-3">
          {PLATFORMS.map((platform) => (
            <label key={platform} className="flex items-center gap-1.5 text-sm">
              <Checkbox
                checked={compatibility.platforms.includes(platform)}
                aria-label={t(`platforms.${platform}`)}
                onCheckedChange={(checked) =>
                  patchCompatibility({
                    platforms:
                      checked === true
                        ? [...compatibility.platforms, platform]
                        : compatibility.platforms.filter((item) => item !== platform),
                  })
                }
              />
              {t(`platforms.${platform}`)}
            </label>
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="template-min-host">{t("minHostVersion")}</Label>
            <Input
              id="template-min-host"
              className="h-8 font-mono text-xs"
              placeholder="0.0.0"
              value={compatibility.minHostVersion ?? ""}
              onChange={(event) =>
                patchCompatibility({ minHostVersion: event.target.value || undefined })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="template-max-host">{t("maxHostVersion")}</Label>
            <Input
              id="template-max-host"
              className="h-8 font-mono text-xs"
              placeholder="0.0.0"
              value={compatibility.maxHostVersion ?? ""}
              onChange={(event) =>
                patchCompatibility({ maxHostVersion: event.target.value || undefined })
              }
            />
          </div>
        </div>
      </fieldset>

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium">{t("dependencies")}</legend>
        <p className="text-xs text-muted-foreground">{t("dependenciesHint")}</p>
        {dependencies.map((dependency, index) => (
          <div
            key={index}
            className="flex flex-wrap items-center gap-2"
            data-testid="template-dependency-row"
          >
            <Input
              className="h-8 w-44 font-mono text-xs"
              aria-label={t("dependencyId")}
              value={dependency.id}
              onChange={(event) => patchDependency(index, { id: event.target.value })}
            />
            <Select
              value={dependency.kind}
              onValueChange={(kind) =>
                patchDependency(index, { kind: kind as TemplateDependency["kind"] })
              }
            >
              <SelectTrigger className="h-8 w-32" aria-label={t("dependencyKind")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEPENDENCY_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`dependencyKinds.${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={dependency.requirement}
              onValueChange={(requirement) =>
                patchDependency(index, {
                  requirement: requirement as TemplateDependency["requirement"],
                  // An `omit`/`default` fallback only means anything on an
                  // optional dependency: preflight blocks on a missing required
                  // one and never reaches the fallback.
                  ...(requirement === "required" ? { fallback: undefined } : {}),
                })
              }
            >
              <SelectTrigger className="h-8 w-32" aria-label={t("dependencyRequirement")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="required">{t("required")}</SelectItem>
                <SelectItem value="optional">{t("optional")}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="h-8 w-28 font-mono text-xs"
              aria-label={t("dependencyVersion")}
              placeholder={t("dependencyVersion")}
              value={dependency.version ?? ""}
              onChange={(event) =>
                patchDependency(index, { version: event.target.value || undefined })
              }
            />
            {dependency.requirement === "optional" ? (
              <Select
                value={dependency.fallback ?? "omit"}
                onValueChange={(fallback) =>
                  patchDependency(index, {
                    fallback: fallback as NonNullable<TemplateDependency["fallback"]>,
                  })
                }
              >
                <SelectTrigger className="h-8 w-28" aria-label={t("dependencyFallback")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEPENDENCY_FALLBACKS.map((fallback) => (
                    <SelectItem key={fallback} value={fallback}>
                      {t(`dependencyFallbacks.${fallback}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("removeDependency")}
              onClick={() =>
                onChange({
                  ...value,
                  dependencies: dependencies.filter((_, i) => i !== index),
                })
              }
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange({
              ...value,
              dependencies: [
                ...dependencies,
                { id: "", kind: "template", requirement: "required" },
              ],
            })
          }
        >
          <PlusIcon className="size-3.5" />
          {t("addDependency")}
        </Button>
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor="template-capabilities">{t("capabilities")}</Label>
        <MultiEntityPicker
          id="template-capabilities"
          value={capabilities}
          onChange={(next) => onChange({ ...value, capabilities: next })}
          options={KNOWN_CAPABILITIES.map((name) => ({ value: name, label: name }))}
          emptyHint={t("capabilitiesHint")}
        />
      </div>

      <fieldset className="space-y-2 rounded-md border p-3">
        <legend className="px-1 text-xs font-medium">{t("localized")}</legend>
        <p className="text-xs text-muted-foreground">{t("localizedHint")}</p>
        {localizedEntries.map(([locale, entry]) => (
          <div
            key={locale}
            className="flex flex-wrap items-center gap-2"
            data-testid="template-localized-row"
          >
            <span className="w-16 font-mono text-xs">{locale}</span>
            <Input
              className="h-8 min-w-0 flex-1"
              aria-label={t("localizedName", { locale })}
              value={entry.name}
              onChange={(event) => patchLocalized(locale, { name: event.target.value })}
            />
            <Input
              className="h-8 min-w-0 flex-1"
              aria-label={t("localizedDescription", { locale })}
              value={entry.description ?? ""}
              onChange={(event) =>
                patchLocalized(locale, { description: event.target.value || undefined })
              }
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("removeLocalized", { locale })}
              onClick={() => removeLocalized(locale)}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        ))}
        {untranslated.map((locale) => (
          <Button
            key={locale}
            size="sm"
            variant="outline"
            onClick={() => patchLocalized(locale, { name: "" })}
          >
            <PlusIcon className="size-3.5" />
            {t("addLocalized", { locale })}
          </Button>
        ))}
      </fieldset>
    </div>
  )
}
