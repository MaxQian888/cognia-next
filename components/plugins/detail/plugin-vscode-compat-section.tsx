"use client"

// What a VS Code extension uses that Cognia does not provide, in the plugin
// detail's overview: the contributions the adapter recorded at install
// (`VsCodeUnsupportedContribution`), the unsupported VS Code APIs found in its
// code, and the activation events Cognia never fires. Rule 7's UI axis for
// those areas; the extension log says the same thing at runtime.
//
// Nothing is listed (and the section is absent) for an extension that uses
// none of them, or for other plugin types.

import { useTranslations } from "next-intl"
import { PuzzleIcon } from "lucide-react"

import type { PluginManifest } from "@/types/plugin"
import type { VsCodeUnsupportedContribution } from "@/types/plugin/plugin-vscode"
import { PluginDetailGroup } from "./plugin-detail-group"

/** Message key per contribution (next-intl keys stay camelCase). */
const CONTRIBUTION_KEYS: Record<VsCodeUnsupportedContribution, string> = {
  "esm-bundle": "esmBundle",
  debuggers: "debuggers",
  notebooks: "notebooks",
  views: "views",
  menus: "menus",
  keybindings: "keybindings",
  "editor-grammars": "editorGrammars",
  "extension-pack": "extensionPack",
}

const isKnownContribution = (value: unknown): value is VsCodeUnsupportedContribution =>
  typeof value === "string" && Object.hasOwn(CONTRIBUTION_KEYS, value)

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

export function PluginVscodeCompatSection({ manifest }: { manifest: PluginManifest }) {
  const t = useTranslations("plugins.vscodeCompat")
  const block = manifest.type === "vscode-extension" ? manifest.vscodeExtension : undefined
  if (!block) return null
  const contributions = (
    Array.isArray(block.unsupportedContributions) ? block.unsupportedContributions : []
  ).filter(isKnownContribution)
  const apis = strings(block.unsupportedApis)
  const events = strings(block.unsupportedActivationEvents)
  if (contributions.length === 0 && apis.length === 0 && events.length === 0) return null

  return (
    <PluginDetailGroup
      title={t("title")}
      icon={<PuzzleIcon className="size-3.5 text-amber-600" />}
      testId="plugin-vscode-compat-section"
    >
      <p className="mb-2 text-xs text-muted-foreground">{t("description")}</p>
      <ul className="space-y-1.5 text-xs">
        {contributions.map((kind) => (
          <li key={kind} data-testid={`plugin-vscode-compat-${kind}`}>
            <span className="font-medium">
              {t(`contributions.${CONTRIBUTION_KEYS[kind]}.title` as never)}
            </span>
            <span className="text-muted-foreground">
              {" "}
              {t(`contributions.${CONTRIBUTION_KEYS[kind]}.description` as never)}
            </span>
          </li>
        ))}
        {apis.length > 0 ? (
          <li data-testid="plugin-vscode-compat-apis">
            <span className="font-medium">{t("apis.title")}</span>
            <span className="text-muted-foreground"> {t("apis.description")}</span>
            <CodeList values={apis} />
          </li>
        ) : null}
        {events.length > 0 ? (
          <li data-testid="plugin-vscode-compat-activation">
            <span className="font-medium">{t("activation.title")}</span>
            <span className="text-muted-foreground"> {t("activation.description")}</span>
            <CodeList values={events} />
          </li>
        ) : null}
      </ul>
    </PluginDetailGroup>
  )
}

function CodeList({ values }: { values: string[] }) {
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {values.map((value) => (
        <code key={value} className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          {value}
        </code>
      ))}
    </div>
  )
}
