"use client"

/**
 * Agent-scoped `Character.instructionsOverride` editor.
 *
 * `resolveSendOptions` reads `character.instructionsOverride ??
 * appSettings.instructions`, i.e. the agent value replaces the app config
 * WHOLESALE while set — so this is inherit-or-own. Taking it over starts from
 * an empty config, which `resolveInstructionsConfig` reads as the built-in
 * defaults; the controls display those resolved values so what is shown is
 * what will run.
 *
 * Controls and labels mirror the app-level `InstructionsCard`
 * (`settings.instructions`), which keeps its own draft and saves into app
 * settings. Every edit here patches the stored object, so keys this form does
 * not show (`fileNames`, byte / file caps) survive untouched.
 */

import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  resolveInstructionsConfig,
  type InstructionMode,
  type InstructionsConfig,
} from "@/lib/claude/instructions/types"
import { InheritSelect } from "./inherit-select"

const MODES: InstructionMode[] = ["layered", "nearest"]

/** One path or glob per line; blank lines dropped. Empty → `undefined`. */
export function parseExtraPaths(raw: string): string[] | undefined {
  const paths = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  return paths.length > 0 ? paths : undefined
}

export interface InstructionsOverrideProps {
  value: InstructionsConfig | undefined
  onChange: (next: InstructionsConfig | undefined) => void
}

export function InstructionsOverride({ value, onChange }: InstructionsOverrideProps) {
  const t = useTranslations("settings.characters.editor.advanced.instructions")
  const tApp = useTranslations("settings.instructions")
  const resolved = resolveInstructionsConfig(value)

  const patch = (next: Partial<InstructionsConfig>) => onChange({ ...value, ...next })

  return (
    <div className="space-y-2" data-testid="agent-override-instructions">
      <InheritSelect<"override">
        id="agent-override-instructions"
        label={t("label")}
        description={t("description")}
        value={value === undefined ? undefined : "override"}
        options={[{ value: "override", label: t("override") }]}
        onChange={(choice) => onChange(choice === undefined ? undefined : { ...value })}
      />
      {value !== undefined && (
        <div className="space-y-3 rounded-md border bg-background p-2">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="agent-instructions-enabled" className="text-xs">
                {tApp("enabled")}
              </Label>
              <p className="text-[10px] text-muted-foreground">{tApp("enabledHint")}</p>
            </div>
            <Switch
              id="agent-instructions-enabled"
              checked={resolved.enabled}
              onCheckedChange={(enabled) => patch({ enabled })}
              aria-label={tApp("enabled")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-instructions-mode" className="text-xs">
              {tApp("mode.label")}
            </Label>
            <Select
              value={resolved.mode}
              disabled={!resolved.enabled}
              onValueChange={(mode) => patch({ mode: mode as InstructionMode })}
            >
              <SelectTrigger id="agent-instructions-mode" aria-label={tApp("mode.label")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {tApp(`mode.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[10px] text-muted-foreground">{tApp("mode.hint")}</p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="agent-instructions-global" className="text-xs">
                {tApp("includeGlobal")}
              </Label>
              <p className="text-[10px] text-muted-foreground">{tApp("includeGlobalHint")}</p>
            </div>
            <Switch
              id="agent-instructions-global"
              checked={resolved.includeGlobal}
              disabled={!resolved.enabled}
              onCheckedChange={(includeGlobal) => patch({ includeGlobal })}
              aria-label={tApp("includeGlobal")}
            />
          </div>
          {resolved.includeGlobal && (
            <div className="space-y-1">
              <Label htmlFor="agent-instructions-global-path" className="text-xs">
                {tApp("globalPath")}
              </Label>
              <Input
                id="agent-instructions-global-path"
                value={value.globalPath ?? ""}
                disabled={!resolved.enabled}
                onChange={(e) => patch({ globalPath: e.target.value || undefined })}
                placeholder={tApp("globalPathPlaceholder")}
                className="font-mono text-xs"
              />
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="agent-instructions-agents" className="text-xs">
                {tApp("loadProjectAgents")}
              </Label>
              <p className="text-[10px] text-muted-foreground">{tApp("loadProjectAgentsHint")}</p>
            </div>
            <Switch
              id="agent-instructions-agents"
              checked={resolved.loadProjectAgents}
              disabled={!resolved.enabled}
              onCheckedChange={(loadProjectAgents) => patch({ loadProjectAgents })}
              aria-label={tApp("loadProjectAgents")}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="agent-instructions-extra" className="text-xs">
              {tApp("extraPaths")}
            </Label>
            <Textarea
              id="agent-instructions-extra"
              rows={3}
              // Uncontrolled + commit on blur: parsing per keystroke would eat
              // the newline the user just typed.
              defaultValue={(value.extraPaths ?? []).join("\n")}
              disabled={!resolved.enabled}
              onBlur={(e) => {
                const extraPaths = parseExtraPaths(e.target.value)
                const current = value.extraPaths ?? []
                const same =
                  (extraPaths ?? []).length === current.length &&
                  (extraPaths ?? []).every((path, i) => path === current[i])
                if (!same) patch({ extraPaths })
              }}
              placeholder={tApp("extraPathsPlaceholder")}
              aria-label={tApp("extraPaths")}
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">{tApp("extraPathsHint")}</p>
          </div>
        </div>
      )}
    </div>
  )
}
