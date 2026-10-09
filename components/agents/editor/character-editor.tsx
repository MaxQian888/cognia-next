"use client"

/**
 * The agent form (ADR-0220): every field a `Character` carries, in one editor
 * used by the agents console (Settings tab and blank create) and by the
 * conversational builder's draft panel.
 *
 * Uncontrolled by default (`initial` + `onSave`). Pass `value` and
 * `onValueChange` to drive it from outside: the builder hands it the draft the
 * builder tools write, and reads back what the person types. The projection to
 * and from a `Character` is `lib/agents/editor-state.ts`, shared with the
 * builder's tools so a draft is validated by the rules this form applies.
 */

import { useEffect, useMemo, useState, type ChangeEvent, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Slider } from "@/components/ui/slider"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  AgentEnvBinding,
  AppSettings,
  Character,
  McpServer,
  Skill,
} from "@cognia/agent-config-types"
import type { KnowledgeBase } from "@/types/knowledge-base"
import type { PluginRuntimeProfile } from "@/types/plugin/plugin"
import {
  ORDERED_TTS_PROVIDERS,
  TTS_PROVIDER_SETTINGS,
  TTS_PROVIDERS,
  type SelectableTTSProvider,
} from "@cognia/tts/types"
// ADR-0020 W2 — Computer Use sub-settings UI reads the live native-tool
// registry so allowedToolIds is a real picker (one checkbox per
// registered tool) instead of a free-form text field. `listEntries`
// returns the same shape `applyComputerUseTools` filters against.
import { listNativeAnthropicToolEntries } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import { usePluginSkills } from "@/hooks/skills/use-plugin-skills"
import { useSandboxConnections } from "@/hooks/automation/use-sandbox-connections"
import { useSubscriptionAccounts } from "@/lib/subscription/core/hooks"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { TestTtsButton } from "@/components/settings/speech/test-tts-button"
import {
  TwinBindingSection,
  type TwinBindingValue,
} from "@/components/settings/character/twin-binding-section"
import { AdvancedOverridesSection } from "@/components/settings/character/advanced-overrides-section"
import { AgentRuntimeField } from "@/components/agents/editor/agent-runtime-field"
import { resolveCharacterVoice } from "@/lib/plugin/character-pack/character-voice"
import { buildVoiceProfile } from "@/lib/plugin/character-pack/editor-projection"
import { modelPresetOptions, PERMISSION_MODE_VALUES } from "@/lib/claude/model-presets"
import { createAgentEnvSecretRef, saveAgentEnvSecret } from "@/lib/agent/agent-env-keyring"
import {
  AGENT_AVATAR_COLORS,
  editorStateToOutput,
  normalizedEnvBindings,
  parseToolChips,
  validateEditorState,
  type EditorOutput,
  type EditorState,
  type EditorValidationIssue,
} from "@/lib/agents/editor-state"
import { createLogger } from "@cognia/logging"

export type { EditorOutput, EditorState } from "@/lib/agents/editor-state"

const log = createLogger("agents.editor")

// ADR-0030 v2 — per-character voice profile editor support. Reuses the
// existing TTS voice catalogs (`lib/tts/types.ts`). `system` has no static
// catalog (browser voices load at runtime), so its voiceId is free-text.
const VOICE_CATALOG: Partial<
  Record<SelectableTTSProvider, ReadonlyArray<{ id: string; name: string }>>
> = Object.fromEntries(
  ORDERED_TTS_PROVIDERS.flatMap((provider) => {
    const voices = TTS_PROVIDER_SETTINGS[provider].voices
    return voices ? [[provider, voices]] : []
  })
)

const PLATFORM_OPTIONS: PluginRuntimeProfile[] = ["tauri", "browser", "mobile"]

/** Labelled 0.05-step slider for the voice rate / pitch / volume controls. */
function VoiceSlider({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (n: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <span className="text-xs tabular-nums text-muted-foreground">{value.toFixed(2)}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={0.05}
        onValueChange={(v) => onChange(v[0])}
        aria-label={label}
      />
    </div>
  )
}

type AgentMemoryScope = EditorState["memoryReadableScopes"][number]
type MemoryBooleanField =
  "memoryRecall" | "memoryCreate" | "memoryUpdate" | "memoryForget" | "memoryAutoLearn"

const AGENT_MEMORY_SCOPES: readonly AgentMemoryScope[] = [
  "global",
  "workspace",
  "character",
  "agent",
]

function MemoryPolicyEditor({
  state,
  onChange,
}: {
  state: EditorState
  onChange: (next: EditorState) => void
}) {
  const t = useTranslations("settings.characters.editor.memoryPolicy")
  const operationRows: Array<{ field: MemoryBooleanField; label: string }> = [
    { field: "memoryRecall", label: t("operations.recall") },
    { field: "memoryCreate", label: t("operations.create") },
    { field: "memoryUpdate", label: t("operations.update") },
    { field: "memoryForget", label: t("operations.forget") },
    { field: "memoryAutoLearn", label: t("operations.autoLearn") },
  ]

  const toggleScope = (
    field: "memoryReadableScopes" | "memoryWritableScopes",
    scope: AgentMemoryScope
  ) => {
    const selected = state[field]
    onChange({
      ...state,
      [field]: selected.includes(scope)
        ? selected.filter((candidate) => candidate !== scope)
        : [...selected, scope],
    })
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="space-y-1">
        <Label className="text-xs font-medium">{t("title")}</Label>
        <p className="text-[10px] text-muted-foreground">{t("description")}</p>
        <p className="text-[10px] text-muted-foreground">{t("globalCeiling")}</p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {operationRows.map(({ field, label }) => (
          <div key={field} className="flex items-center justify-between gap-3 rounded border p-2">
            <Label className="cursor-pointer text-xs" htmlFor={`character-${field}`}>
              {label}
            </Label>
            <Switch
              id={`character-${field}`}
              checked={state[field]}
              onCheckedChange={(checked) => onChange({ ...state, [field]: checked })}
              aria-label={label}
            />
          </div>
        ))}
      </div>

      {(
        [
          ["memoryReadableScopes", t("readableScopes")],
          ["memoryWritableScopes", t("writableScopes")],
        ] as const
      ).map(([field, label]) => (
        <fieldset key={field} className="space-y-2">
          <legend className="text-xs font-medium">{label}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {AGENT_MEMORY_SCOPES.map((scope) => {
              const id = `character-${field}-${scope}`
              return (
                <div key={scope} className="flex items-center gap-2">
                  <Checkbox
                    id={id}
                    checked={state[field].includes(scope)}
                    onCheckedChange={() => toggleScope(field, scope)}
                    aria-label={`${label}: ${t(`scopes.${scope}`)}`}
                  />
                  <Label htmlFor={id} className="cursor-pointer text-xs">
                    {t(`scopes.${scope}`)}
                  </Label>
                </div>
              )
            })}
          </div>
        </fieldset>
      ))}
    </div>
  )
}

interface EditorProps {
  /** The form's starting state, and the baseline secret bindings are compared against. */
  initial: EditorState
  /** Controlled state. When set the editor renders it and reports edits through `onValueChange`. */
  value?: EditorState
  onValueChange?: (next: EditorState) => void
  skillsCatalog: Skill[]
  mcpCatalog: McpServer[]
  knowledgeBaseCatalog: KnowledgeBase[]
  submitLabel: string
  /** Label of the button that calls `onCancel`. Defaults to "Cancel". */
  cancelLabel?: string
  onCancel: () => void
  onSave: (data: EditorOutput) => Promise<void>
  /** Id of the character being edited. Omitted when creating. */
  editingId?: string
  /** `card` frames the form; `plain` lets a host panel provide the frame. */
  chrome?: "card" | "plain"
  /** Rendered at the start of the footer row (a status line, a hint). */
  footerStart?: ReactNode
}

export function CharacterEditor({
  initial,
  value,
  onValueChange,
  skillsCatalog,
  mcpCatalog,
  knowledgeBaseCatalog,
  submitLabel,
  cancelLabel,
  onCancel,
  onSave,
  editingId,
  chrome = "card",
  footerStart,
}: EditorProps) {
  const t = useTranslations("settings.characters")
  const tEditor = useTranslations("settings.characters.editor")
  const pluginSkillOptions = usePluginSkills("character")
  const tGeneral = useTranslations("settings.general")
  const tSandbox = useTranslations("settings.characters.editor.sandbox")
  const tAccount = useTranslations("settings.characters.editor.account")
  const [s, setS] = useState<EditorState>(value ?? initial)
  // Adopt a new value from outside (an `initial` swap when uncontrolled, a
  // `value` the host wrote when controlled) during render, the documented way
  // to adjust state to a prop. Our own edits come back as the same object and
  // are not re-adopted.
  const external = value ?? initial
  const [adopted, setAdopted] = useState<EditorState>(external)
  if (external !== adopted) {
    setAdopted(external)
    setS(external)
  }
  useEffect(() => {
    if (onValueChange && s !== adopted) onValueChange(s)
  }, [s, adopted, onValueChange])
  // The cua-desktop tier runs shell and file work inside the bound desktop, so
  // it needs one. `validateSandboxSessionBinding` requires
  // `computerTarget === "bound"`, and Computer Use has to be on for a target to
  // mean anything at all.
  const hasBoundDesktop = s.enableComputerUse && s.computerUseTarget !== "local"
  // The tool lists are typed as free text; the parsed list is what the state
  // holds. The text is re-derived whenever the list changes under it.
  const [allowToolsText, setAllowToolsText] = useState(s.allowedTools.join(", "))
  const [denyToolsText, setDenyToolsText] = useState(s.disallowedTools.join(", "))
  if (parseToolChips(allowToolsText).join(",") !== s.allowedTools.join(",")) {
    setAllowToolsText(s.allowedTools.join(", "))
  }
  if (parseToolChips(denyToolsText).join(",") !== s.disallowedTools.join(",")) {
    setDenyToolsText(s.disallowedTools.join(", "))
  }
  const [envSecretValues, setEnvSecretValues] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const { byProvider: subscriptionAccounts, providers: subscriptionProviders } =
    useSubscriptionAccounts()
  const accountOptions = useMemo(
    () =>
      Object.entries(subscriptionAccounts).flatMap(([provider, state]) =>
        state.accounts.map((account) => ({
          accountId: account.id,
          provider: subscriptionProviders.find((entry) => entry.id === provider)?.name ?? provider,
          label: account.label ?? account.email ?? account.id.slice(0, 8),
        }))
      ),
    [subscriptionAccounts, subscriptionProviders]
  )

  // Voice catalog for the currently-selected provider (undefined for
  // `system` / no provider — those fall back to a free-text voice id).
  const voiceCatalog = s.voiceProvider !== "none" ? VOICE_CATALOG[s.voiceProvider] : undefined

  // Read a picked image file into a `data:` URL stored on the character.
  // Warns (non-blocking, mirrors `defineCharacterPack`) when the encoded
  // payload exceeds 64 KB — keeps the Dexie row small.
  const handleAvatarFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = "" // allow re-selecting the same file
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : ""
      if (!result) return
      if (result.length > 64 * 1024) {
        toast.warning(tEditor("avatarImage.large"))
      }
      setS((prev) => ({ ...prev, avatarImageDataUrl: result }))
    }
    reader.readAsDataURL(file)
  }

  const issueMessage = (issue: EditorValidationIssue): string => {
    switch (issue.code) {
      case "nameRequired":
        return t("validation.nameRequired")
      case "systemPromptRequired":
        return t("validation.systemPromptRequired")
      case "maxTurnsInvalid":
        return tEditor("execution.maxTurnsInvalid")
      case "envNameInvalid":
        return tEditor("execution.envNameInvalid", { name: issue.name })
      case "envNameDuplicate":
        return tEditor("execution.envNameDuplicate", { name: issue.name })
    }
  }

  const submit = async () => {
    const issue = validateEditorState(s)
    if (issue) {
      toast.error(issueMessage(issue))
      return
    }
    const envBindings = normalizedEnvBindings(s)
    const initialSecretRefs = new Set(
      (initial.executionEnvBindings ?? [])
        .filter(
          (binding): binding is Extract<AgentEnvBinding, { kind: "secret" }> =>
            binding.kind === "secret"
        )
        .map((binding) => binding.secretRef)
    )
    for (const binding of envBindings) {
      if (
        binding.kind === "secret" &&
        !initialSecretRefs.has(binding.secretRef) &&
        !envSecretValues[binding.secretRef]
      ) {
        toast.error(tEditor("execution.envSecretRequired", { name: binding.name }))
        return
      }
    }
    setSaving(true)
    try {
      for (const binding of envBindings) {
        if (binding.kind !== "secret") continue
        const secret = envSecretValues[binding.secretRef]
        if (!secret) continue
        try {
          await saveAgentEnvSecret(binding.secretRef, secret)
        } catch (error) {
          log.error("agent_env_secret_save_failed", error, { name: binding.name })
          toast.error(tEditor("execution.envSecretSaveFailed", { name: binding.name }))
          return
        }
      }
      await onSave(editorStateToOutput(s))
    } finally {
      setSaving(false)
    }
  }

  const Frame = chrome === "card" ? Card : "div"
  return (
    <Frame className={chrome === "card" ? "space-y-4 p-4" : "space-y-4"}>
      <div className="grid grid-cols-[auto_1fr] gap-3">
        <div className="flex flex-col items-center gap-2">
          <AvatarBadge
            subject={{
              name: s.name,
              avatarColor: s.avatarColor || AGENT_AVATAR_COLORS[0],
              avatarEmoji: s.avatarEmoji,
              avatarImageUrl: s.avatarImageDataUrl || undefined,
            }}
            size={48}
            textClassName="text-lg"
          />
          <Input
            value={s.avatarEmoji}
            onChange={(e) => setS({ ...s, avatarEmoji: e.target.value })}
            placeholder={tEditor("avatarEmojiPlaceholder")}
            className="h-7 w-12 text-center"
            maxLength={4}
            aria-label={tEditor("avatarEmoji")}
          />
          <div className="grid grid-cols-4 gap-1">
            {AGENT_AVATAR_COLORS.map((c) => (
              <Button
                key={c}
                type="button"
                variant="outline"
                size="icon"
                onClick={() => setS({ ...s, avatarColor: c })}
                className="size-4 rounded-full p-0 ring-1 ring-border"
                style={{
                  backgroundColor: c,
                  outline: s.avatarColor === c ? "2px solid var(--ring)" : undefined,
                  outlineOffset: 2,
                }}
                aria-label={tEditor("pickColor", { color: c })}
              />
            ))}
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <label className="cursor-pointer text-[10px] text-primary underline-offset-2 hover:underline">
              {tEditor("avatarImage.upload")}
              <Input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarFile}
                aria-label={tEditor("avatarImage.upload")}
              />
            </label>
            {s.avatarImageDataUrl && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-[10px] text-muted-foreground"
                onClick={() => setS({ ...s, avatarImageDataUrl: "" })}
              >
                {tEditor("avatarImage.clear")}
              </Button>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("name")}</Label>
            <Input
              value={s.name}
              onChange={(e) => setS({ ...s, name: e.target.value })}
              placeholder={tEditor("namePlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("description")}</Label>
            <Input
              value={s.description}
              onChange={(e) => setS({ ...s, description: e.target.value })}
              placeholder={tEditor("descriptionPlaceholder")}
            />
          </div>
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{tEditor("systemPrompt")}</Label>
        <Textarea
          rows={6}
          value={s.systemPrompt}
          onChange={(e) => setS({ ...s, systemPrompt: e.target.value })}
          className="text-sm"
          placeholder={tEditor("systemPromptPlaceholder")}
        />
      </div>

      {/* ADR-0030 v2 — persona (tone / personality / opening / exemplars) */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <Label className="text-xs font-medium">{tEditor("persona.title")}</Label>
        <p className="text-[10px] text-muted-foreground">{tEditor("persona.description")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("persona.tone")}</Label>
            <Input
              value={s.personaTone}
              onChange={(e) => setS({ ...s, personaTone: e.target.value })}
              placeholder={tEditor("persona.tonePlaceholder")}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("persona.personality")}</Label>
            <Input
              value={s.personaPersonality}
              onChange={(e) => setS({ ...s, personaPersonality: e.target.value })}
              placeholder={tEditor("persona.personalityPlaceholder")}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("persona.openingMessage")}</Label>
          <Textarea
            rows={2}
            value={s.openingMessage}
            onChange={(e) => setS({ ...s, openingMessage: e.target.value })}
            className="text-sm"
            placeholder={tEditor("persona.openingMessagePlaceholder")}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("persona.exemplarPrompts")}</Label>
          <Textarea
            rows={3}
            value={s.exemplarPromptsText}
            onChange={(e) => setS({ ...s, exemplarPromptsText: e.target.value })}
            className="text-sm"
            placeholder={tEditor("persona.exemplarPromptsPlaceholder")}
          />
          <p className="text-[10px] text-muted-foreground">
            {tEditor("persona.exemplarPromptsHint")}
          </p>
        </div>
      </div>

      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <div>
          <Label className="text-xs font-medium">{tEditor("routing.title")}</Label>
          <p className="text-[10px] text-muted-foreground">{tEditor("routing.description")}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("routing.plan")}</Label>
            <Input
              value={s.planModel}
              onChange={(e) => setS({ ...s, planModel: e.target.value })}
              placeholder={tEditor("routing.planPlaceholder")}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("routing.execute")}</Label>
            <Select
              value={s.model || "__default__"}
              onValueChange={(v) => setS({ ...s, model: v === "__default__" ? "" : v })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{tEditor("useDefault")}</SelectItem>
                {modelPresetOptions().map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={s.model}
              onChange={(e) => setS({ ...s, model: e.target.value })}
              placeholder={tEditor("modelIdPlaceholder")}
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("routing.utility")}</Label>
            <Input
              value={s.utilityModel}
              onChange={(e) => setS({ ...s, utilityModel: e.target.value })}
              placeholder={tEditor("routing.utilityPlaceholder")}
              className="font-mono text-xs"
            />
          </div>
        </div>
      </div>

      <AgentRuntimeField
        value={s.runtime}
        onChange={(runtime) => setS((current) => ({ ...current, runtime }))}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("permissionMode")}</Label>
          <Select
            value={s.permissionMode ?? "__default__"}
            onValueChange={(v) =>
              setS({
                ...s,
                permissionMode:
                  v === "__default__" ? undefined : (v as AppSettings["permissionMode"]),
              })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">{tEditor("useDefault")}</SelectItem>
              {PERMISSION_MODE_VALUES.map((m) => (
                <SelectItem key={m} value={m}>
                  {tGeneral(`permission.${m}` as `permission.${typeof m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("execution.effort")}</Label>
          <Select
            value={s.executionEffort}
            onValueChange={(value) =>
              setS({ ...s, executionEffort: value as EditorState["executionEffort"] })
            }
          >
            <SelectTrigger aria-label={tEditor("execution.effort")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{tEditor("execution.inherit")}</SelectItem>
              {(["low", "medium", "high", "xhigh", "max"] as const).map((effort) => (
                <SelectItem key={effort} value={effort}>
                  {tEditor(`execution.effortValues.${effort}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="agent-max-turns">
            {tEditor("execution.maxTurns")}
          </Label>
          <Input
            id="agent-max-turns"
            type="number"
            min={1}
            max={100}
            value={s.executionMaxTurns}
            onChange={(event) => setS({ ...s, executionMaxTurns: event.target.value })}
            placeholder={tEditor("execution.maxTurnsPlaceholder")}
          />
          <p className="text-[10px] text-muted-foreground">{tEditor("execution.maxTurnsHint")}</p>
        </div>
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label className="text-xs font-medium">{tEditor("execution.envTitle")}</Label>
            <p className="text-[10px] text-muted-foreground">
              {tEditor("execution.envDescription")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setS((current) => ({
                ...current,
                executionEnvBindings: [
                  ...(current.executionEnvBindings ?? []),
                  { name: "", kind: "plain", value: "" },
                ],
              }))
            }
          >
            <PlusIcon className="mr-1 size-3.5" />
            {tEditor("execution.addEnv")}
          </Button>
        </div>
        {(s.executionEnvBindings ?? []).map((binding, index) => {
          const rowId = `agent-env-${index}`
          return (
            <div
              key={`${binding.kind}-${binding.kind === "secret" ? binding.secretRef : index}`}
              className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_7.5rem_1fr_auto]"
            >
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${rowId}-name`}>
                  {tEditor("execution.envName")}
                </Label>
                <Input
                  id={`${rowId}-name`}
                  value={binding.name}
                  onChange={(event) =>
                    setS((current) => ({
                      ...current,
                      executionEnvBindings: (current.executionEnvBindings ?? []).map((item, i) =>
                        i === index ? { ...item, name: event.target.value } : item
                      ),
                    }))
                  }
                  placeholder={tEditor("execution.envNamePlaceholder")}
                  className="font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{tEditor("execution.envKind")}</Label>
                <Select
                  value={binding.kind}
                  onValueChange={(kind) =>
                    setS((current) => ({
                      ...current,
                      executionEnvBindings: (current.executionEnvBindings ?? []).map((item, i) => {
                        if (i !== index || item.kind === kind) return item
                        return kind === "secret"
                          ? {
                              name: item.name,
                              kind: "secret" as const,
                              secretRef: createAgentEnvSecretRef(
                                editingId ?? "new-agent",
                                item.name || "ENV"
                              ),
                            }
                          : { name: item.name, kind: "plain" as const, value: "" }
                      }),
                    }))
                  }
                >
                  <SelectTrigger aria-label={tEditor("execution.envKind")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plain">{tEditor("execution.envPlain")}</SelectItem>
                    <SelectItem value="secret">{tEditor("execution.envSecret")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${rowId}-value`}>
                  {tEditor("execution.envValue")}
                </Label>
                <Input
                  id={`${rowId}-value`}
                  type={binding.kind === "secret" ? "password" : "text"}
                  autoComplete={binding.kind === "secret" ? "new-password" : undefined}
                  value={
                    binding.kind === "secret"
                      ? (envSecretValues[binding.secretRef] ?? "")
                      : binding.value
                  }
                  onChange={(event) => {
                    if (binding.kind === "secret") {
                      setEnvSecretValues((current) => ({
                        ...current,
                        [binding.secretRef]: event.target.value,
                      }))
                      return
                    }
                    setS((current) => ({
                      ...current,
                      executionEnvBindings: (current.executionEnvBindings ?? []).map((item, i) =>
                        i === index && item.kind === "plain"
                          ? { ...item, value: event.target.value }
                          : item
                      ),
                    }))
                  }}
                  placeholder={
                    binding.kind === "secret"
                      ? tEditor("execution.envSecretPlaceholder")
                      : tEditor("execution.envPlainPlaceholder")
                  }
                  className="font-mono text-xs"
                />
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() =>
                  setS((current) => ({
                    ...current,
                    executionEnvBindings: (current.executionEnvBindings ?? []).filter(
                      (_, i) => i !== index
                    ),
                  }))
                }
                aria-label={tEditor("execution.removeEnv", { name: binding.name || "?" })}
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("allowedTools")}</Label>
          <Input
            value={allowToolsText}
            onChange={(e) => {
              const text = e.target.value
              setAllowToolsText(text)
              setS((current) => ({ ...current, allowedTools: parseToolChips(text) }))
            }}
            placeholder={tEditor("allowedToolsPlaceholder")}
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tEditor("disallowedTools")}</Label>
          <Input
            value={denyToolsText}
            onChange={(e) => {
              const text = e.target.value
              setDenyToolsText(text)
              setS((current) => ({ ...current, disallowedTools: parseToolChips(text) }))
            }}
            placeholder={tEditor("disallowedToolsPlaceholder")}
            className="font-mono text-xs"
          />
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{tEditor("workingDir")}</Label>
        <Input
          value={s.workingDir}
          onChange={(e) => setS({ ...s, workingDir: e.target.value })}
          placeholder={tEditor("workingDirPlaceholder")}
          className="font-mono text-xs"
        />
      </div>

      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <div className="flex items-center justify-between gap-3">
          <Label className="cursor-pointer text-xs">{tGeneral("bareMode")}</Label>
          <Switch
            checked={s.bareMode}
            onCheckedChange={(v) => setS({ ...s, bareMode: v })}
            aria-label={tGeneral("bareMode")}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label className="cursor-pointer text-xs">{tGeneral("debugMode")}</Label>
          <Switch
            checked={s.debugMode}
            onCheckedChange={(v) => setS({ ...s, debugMode: v })}
            aria-label={tGeneral("debugMode")}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label className="cursor-pointer text-xs">{tGeneral("briefMode")}</Label>
          <Switch
            checked={s.briefMode}
            onCheckedChange={(v) => setS({ ...s, briefMode: v })}
            aria-label={tGeneral("briefMode")}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="cursor-pointer text-xs">{tEditor("computerUseToggle.label")}</Label>
            <p className="text-[10px] text-muted-foreground">
              {tEditor("computerUseToggle.description")}
            </p>
          </div>
          <Switch
            checked={s.enableComputerUse}
            onCheckedChange={(v) => setS({ ...s, enableComputerUse: v })}
            aria-label={tEditor("computerUseToggle.aria")}
          />
        </div>
        {s.enableComputerUse && (
          <>
            <ComputerUseSubSettings
              value={s.computerUseSettings}
              onChange={(next) => setS({ ...s, computerUseSettings: next })}
            />
            <ComputerUseTargetPicker
              value={s.computerUseTarget}
              onChange={(target) =>
                setS({
                  ...s,
                  computerUseTarget: target,
                  // Dropping back to the local desktop leaves `cua-desktop`
                  // with nothing to bind to, which would save a combination
                  // that can only ever be refused at send time. Fall back to
                  // inheriting rather than persisting an unusable tier.
                  sandboxTier:
                    target === "local" && s.sandboxTier === "cua-desktop"
                      ? "inherit"
                      : s.sandboxTier,
                })
              }
            />
          </>
        )}
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="cursor-pointer text-xs">{tEditor("browserToolsToggle.label")}</Label>
            <p className="text-[10px] text-muted-foreground">
              {tEditor("browserToolsToggle.description")}
            </p>
          </div>
          <Switch
            checked={s.enableBrowserTools}
            onCheckedChange={(v) => setS({ ...s, enableBrowserTools: v })}
            aria-label={tEditor("browserToolsToggle.aria")}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label className="cursor-pointer text-xs">{tSandbox("enable.label")}</Label>
            <p className="text-[10px] text-muted-foreground">{tSandbox("enable.description")}</p>
          </div>
          <Switch
            checked={s.sandboxEnabled}
            onCheckedChange={(v) => setS({ ...s, sandboxEnabled: v })}
            aria-label={tSandbox("enable.aria")}
            data-testid="character-sandbox-enabled"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tSandbox("tier.label")}</Label>
          <Select
            value={s.sandboxTier}
            onValueChange={(value) =>
              setS({
                ...s,
                sandboxTier: value as EditorState["sandboxTier"],
              })
            }
          >
            <SelectTrigger data-testid="character-sandbox-tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{tSandbox("tier.inherit")}</SelectItem>
              <SelectItem value="os">{tSandbox("tier.os")}</SelectItem>
              <SelectItem value="microvm">{tSandbox("tier.microvm")}</SelectItem>
              {/*
                The tier runs shell and file work inside the bound desktop, so
                it is meaningless without one: `validateSandboxSessionBinding`
                requires `computerTarget === "bound"`. Offering it while the
                target is local would save a combination that can only ever be
                refused at send time. It is disabled for that reason and not
                hidden, so the requirement is discoverable.
              */}
              <SelectItem value="cua-desktop" disabled={!hasBoundDesktop}>
                {tSandbox("tier.cuaDesktop")}
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">{tSandbox("tier.description")}</p>
          {!hasBoundDesktop && (
            <p className="text-[10px] text-muted-foreground">
              {tSandbox("tier.cuaDesktopNeedsBoundDesktop")}
            </p>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{tAccount("label")}</Label>
          <Select
            value={s.accountIdOverride}
            onValueChange={(value) =>
              setS({
                ...s,
                accountIdOverride: value as EditorState["accountIdOverride"],
              })
            }
          >
            <SelectTrigger data-testid="character-account-override">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inherit">{tAccount("inherit")}</SelectItem>
              {accountOptions.map((opt) => (
                <SelectItem key={opt.accountId} value={opt.accountId}>
                  {tAccount("optionLabel", {
                    provider: opt.provider,
                    label: opt.label,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">{tAccount("description")}</p>
        </div>
      </div>

      <TwinBindingSection
        value={{ twinId: s.twinId, twinSettings: s.twinSettings }}
        onChange={(next: TwinBindingValue) =>
          setS({ ...s, twinId: next.twinId, twinSettings: next.twinSettings })
        }
        excludeCharacterId={editingId}
      />

      <ItemMultiSelect
        label={tEditor("knowledgeBases")}
        helpText={tEditor("knowledgeBasesHint")}
        items={knowledgeBaseCatalog.map((knowledgeBase) => ({
          id: knowledgeBase.id,
          name: knowledgeBase.name,
          description: knowledgeBase.description,
        }))}
        selectedIds={s.knowledgeBaseIds}
        allowEmpty
        emptyHint={tEditor("knowledgeBasesEmptyHint")}
        onChange={(ids) => setS({ ...s, knowledgeBaseIds: ids })}
      />

      <MemoryPolicyEditor state={s} onChange={setS} />

      <ItemMultiSelect
        label={tEditor("skills")}
        helpText={tEditor("skillsHint")}
        items={skillsCatalog.map((sk) => ({
          id: sk.id,
          name: sk.name,
          description: sk.description,
        }))}
        selectedIds={s.skillIds}
        onChange={(ids) => setS({ ...s, skillIds: ids })}
      />

      {(pluginSkillOptions.length > 0 || s.pluginSkillIds.length > 0) && (
        <ItemMultiSelect
          label={tEditor("pluginSkills")}
          helpText={tEditor("pluginSkillsHint")}
          items={pluginSkillOptions}
          // Ids of plugins that are currently disabled stay selected (and are
          // kept on save) — they resolve again when the plugin is re-enabled.
          selectedIds={s.pluginSkillIds}
          onChange={(ids) => setS({ ...s, pluginSkillIds: ids })}
        />
      )}

      <ItemMultiSelect
        label={tEditor("mcpServers")}
        helpText={tEditor("mcpServersHint")}
        items={mcpCatalog.map((m) => ({
          id: m.id,
          name: m.name,
          description: `${m.transport}${m.enabled ? "" : " — disabled"}`,
        }))}
        selectedIds={s.mcpServerIds ?? []}
        allowEmpty
        emptyHint={tEditor("mcpServersEmptyHint")}
        onChange={(ids) => setS({ ...s, mcpServerIds: ids.length > 0 ? ids : undefined })}
      />

      {/* ADR-0030 v2 — voice profile (rides the existing TTS subsystem) */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <Label className="text-xs font-medium">{tEditor("voice.title")}</Label>
        <p className="text-[10px] text-muted-foreground">{tEditor("voice.description")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{tEditor("voice.provider")}</Label>
            <Select
              value={s.voiceProvider}
              onValueChange={(v) =>
                setS({ ...s, voiceProvider: v as EditorState["voiceProvider"], voiceId: "" })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{tEditor("voice.inherit")}</SelectItem>
                {ORDERED_TTS_PROVIDERS.map((provider) => (
                  <SelectItem key={provider} value={provider}>
                    {TTS_PROVIDERS[provider].name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {s.voiceProvider !== "none" && (
            <div className="space-y-1">
              <Label className="text-xs">{tEditor("voice.voiceId")}</Label>
              {voiceCatalog ? (
                <Select value={s.voiceId} onValueChange={(v) => setS({ ...s, voiceId: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder={tEditor("voice.voiceIdPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {voiceCatalog.map((v) => (
                      <SelectItem key={v.id} value={v.id}>
                        {v.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={s.voiceId}
                  onChange={(e) => setS({ ...s, voiceId: e.target.value })}
                  placeholder={tEditor("voice.voiceIdPlaceholder")}
                  className="font-mono text-xs"
                />
              )}
            </div>
          )}
        </div>
        {s.voiceProvider !== "none" && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <VoiceSlider
                label={tEditor("voice.rate")}
                value={s.voiceRate}
                min={0.5}
                max={2}
                onChange={(n) => setS({ ...s, voiceRate: n })}
              />
              <VoiceSlider
                label={tEditor("voice.pitch")}
                value={s.voicePitch}
                min={0.5}
                max={2}
                onChange={(n) => setS({ ...s, voicePitch: n })}
              />
              <VoiceSlider
                label={tEditor("voice.volume")}
                value={s.voiceVolume}
                min={0}
                max={1}
                onChange={(n) => setS({ ...s, voiceVolume: n })}
              />
            </div>
            <TestTtsButton
              voiceOverlay={resolveCharacterVoice({
                voiceProfile: buildVoiceProfile({
                  provider: s.voiceProvider,
                  voiceId: s.voiceId,
                  rate: s.voiceRate,
                  pitch: s.voicePitch,
                  volume: s.voiceVolume,
                }),
              })}
              sampleText={s.openingMessage.trim() || undefined}
            />
          </div>
        )}
      </div>

      {/* ADR-0030 v2 — platform availability (empty = all) */}
      <div className="space-y-2 rounded-md border bg-muted/20 p-3">
        <Label className="text-xs font-medium">{tEditor("platforms.title")}</Label>
        <p className="text-[10px] text-muted-foreground">{tEditor("platforms.description")}</p>
        <div className="flex flex-wrap gap-1.5">
          {PLATFORM_OPTIONS.map((p) => {
            const active = s.availablePlatforms.includes(p)
            return (
              <Badge
                key={p}
                variant={active ? "default" : "outline"}
                className="cursor-pointer text-xs hover:bg-primary/10"
                onClick={() =>
                  setS({
                    ...s,
                    availablePlatforms: active
                      ? s.availablePlatforms.filter((x) => x !== p)
                      : [...s.availablePlatforms, p],
                  })
                }
              >
                {tEditor(`platforms.${p}` as `platforms.${PluginRuntimeProfile}`)}
              </Badge>
            )
          })}
        </div>
      </div>

      <AdvancedOverridesSection
        value={s.overrides}
        onChange={(overrides) => setS((current) => ({ ...current, overrides }))}
      />

      <div className="flex items-center justify-end gap-2 pt-1">
        {footerStart ? <div className="mr-auto min-w-0">{footerStart}</div> : null}
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {cancelLabel ?? t("cancel")}
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={saving}>
          {saving ? t("saving") : submitLabel}
        </Button>
      </div>
    </Frame>
  )
}

// ADR-0020 W2 — per-character Computer Use sub-settings.
//
// Only rendered when `enableComputerUse === true`. Surfaces three knobs
// that were declared in v40 but had no UI consumer pre-W2:
//
//  - `requireConsent` — forces every driving call into the Rust
//    `PerCall` consent path for this character, regardless of the
//    global `automationSettings.perSurface.computerUse.tier`.
//    `applyComputerUseTools` stamps `forceTier: "perCall"` on each
//    Anthropic tool def when this is set.
//  - `chatConsentMode` — drives Wave 3's chat-side dedup logic. `auto`
//    suppresses the chat modal when the Rust gate is PerCall;
//    `session-grant` remembers the operator's first decision for the
//    session; `always-ask` keeps both gates prompting independently.
//  - `allowedToolIds` — narrows which registered native tools the
//    character actually exposes. Empty set = "all", matching the
//    fast-path in `applyComputerUseTools`.
interface ComputerUseSubSettingsProps {
  value: Character["computerUseSettings"]
  onChange: (next: Character["computerUseSettings"]) => void
}

function ComputerUseSubSettings({ value, onChange }: ComputerUseSubSettingsProps) {
  const t = useTranslations("settings.characters.editor.computerUseSubSettings")
  const v = value ?? {}
  const requireConsent = Boolean(v.requireConsent)
  const consentMode = v.chatConsentMode ?? "always-ask"
  const allowed = v.allowedToolIds ?? []

  // Read the live registry once on mount. The registry doesn't change
  // at runtime within a single render pass, so a useState seed is fine
  // — re-mounting the editor (e.g. switching characters) picks up any
  // newly-enabled tool plugin.
  const [registeredTools] = useState(() =>
    listNativeAnthropicToolEntries().map((row) => ({
      id: row.id,
      name: row.entry.name,
    }))
  )

  function update(patch: Partial<NonNullable<Character["computerUseSettings"]>>): void {
    onChange({ ...v, ...patch })
  }

  function toggleTool(id: string, on: boolean): void {
    const next = new Set(allowed)
    if (on) next.add(id)
    else next.delete(id)
    // Treat "empty set" as "all" by storing `undefined` rather than
    // `[]` — the runtime fast-path in `applyComputerUseTools` reads
    // `undefined` as "no filter" and we keep the stored shape minimal.
    update({ allowedToolIds: next.size === 0 ? undefined : Array.from(next) })
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/10 p-3 pl-4">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="cursor-pointer text-xs">{t("requireConsent.label")}</Label>
          <p className="text-[10px] text-muted-foreground">{t("requireConsent.description")}</p>
        </div>
        <Switch
          checked={requireConsent}
          onCheckedChange={(b) => update({ requireConsent: b })}
          aria-label={t("requireConsent.label")}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="cursor-pointer text-xs">{t("screenOffMode.label")}</Label>
          <p className="text-[10px] text-muted-foreground">{t("screenOffMode.description")}</p>
        </div>
        <Switch
          checked={Boolean(v.screenOffMode)}
          onCheckedChange={(b) => update({ screenOffMode: b })}
          aria-label={t("screenOffMode.label")}
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("chatConsentMode.label")}</Label>
        <p className="text-[10px] text-muted-foreground">{t("chatConsentMode.description")}</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {(["always-ask", "session-grant", "auto"] as const).map((mode) => (
            <Button
              key={mode}
              type="button"
              size="sm"
              variant={consentMode === mode ? "default" : "outline"}
              onClick={() => update({ chatConsentMode: mode })}
            >
              {t(`chatConsentMode.options.${mode}`)}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <Label className="text-xs">{t("allowedToolIds.label")}</Label>
        <p className="text-[10px] text-muted-foreground">{t("allowedToolIds.description")}</p>
        {registeredTools.length === 0 ? (
          <p className="text-[10px] text-muted-foreground">{t("allowedToolIds.empty")}</p>
        ) : (
          <div className="flex flex-wrap gap-2 pt-1">
            {registeredTools.map((tool) => {
              const checked = allowed.length === 0 || allowed.includes(tool.id)
              return (
                <label
                  key={tool.id}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-[11px]"
                >
                  <Input
                    type="checkbox"
                    className="h-3 w-3"
                    checked={checked}
                    onChange={(e) => toggleTool(tool.id, e.target.checked)}
                    aria-label={tool.name}
                  />
                  <code className="font-mono">{tool.name}</code>
                </label>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ADR-0020 remote-target — per-character Computer Use execution target.
// "local" runs GUI actions on this host; selecting a configured cua sandbox
// routes them into that isolated Docker desktop instead. Connections are
// managed in Settings → Automation → Sandboxes.
interface ComputerUseTargetPickerProps {
  value: "local" | string
  onChange: (next: "local" | string) => void
}

function ComputerUseTargetPicker({ value, onChange }: ComputerUseTargetPickerProps) {
  const t = useTranslations("settings.characters.editor.computerUseTarget")
  const { connections } = useSandboxConnections()
  return (
    <div className="space-y-1">
      <Label className="text-xs">{t("label")}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger aria-label={t("label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="local">{t("local")}</SelectItem>
          {connections.map((conn) => (
            <SelectItem key={conn.id} value={conn.id}>
              {conn.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[10px] text-muted-foreground">{t("description")}</p>
    </div>
  )
}

interface MultiSelectProps {
  label: string
  helpText?: string
  items: Array<{ id: string; name: string; description?: string }>
  selectedIds: string[]
  onChange: (ids: string[]) => void
  allowEmpty?: boolean
  emptyHint?: string
}

/**
 * Compact multi-select with optional ordering: clicking adds to the end of
 * the selection (preserving order); clicking again removes.
 */
function ItemMultiSelect({
  label,
  helpText,
  items,
  selectedIds,
  onChange,
  allowEmpty,
  emptyHint,
}: MultiSelectProps) {
  const tMS = useTranslations("settings.characters.multiselect")
  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

  const move = (id: string, dir: -1 | 1) => {
    const idx = selectedIds.indexOf(id)
    if (idx < 0) return
    const target = idx + dir
    if (target < 0 || target >= selectedIds.length) return
    const next = [...selectedIds]
    ;[next[idx], next[target]] = [next[target], next[idx]]
    onChange(next)
  }

  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {helpText && <p className="text-[11px] text-muted-foreground">{helpText}</p>}
      {selectedIds.length === 0 && allowEmpty && emptyHint && (
        <p className="text-[11px] italic text-muted-foreground">{emptyHint}</p>
      )}
      <div className="flex flex-wrap gap-1.5">
        {items.length === 0 ? (
          <p className="text-[11px] italic text-muted-foreground">{tMS("noneDefined")}</p>
        ) : (
          items.map((it) => {
            const active = selectedIds.includes(it.id)
            const order = active ? selectedIds.indexOf(it.id) + 1 : null
            return (
              <Button
                key={it.id}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => toggle(it.id)}
                className={
                  "h-auto gap-1 rounded-pill px-2 py-0.5 text-xs font-normal " +
                  (active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border bg-muted/30 text-muted-foreground hover:bg-muted")
                }
                title={it.description}
              >
                {order !== null && (
                  <span className="font-mono text-[10px] text-muted-foreground">#{order}</span>
                )}
                {it.name}
              </Button>
            )
          })
        )}
      </div>
      {selectedIds.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="text-[11px] text-muted-foreground">{tMS("reorder")}</span>
          {selectedIds.map((id) => {
            const it = items.find((x) => x.id === id)
            if (!it) return null
            return (
              <span
                key={id}
                className="inline-flex items-center gap-0.5 rounded border bg-background px-1 text-[11px]"
              >
                {it.name}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => move(id, -1)}
                  className="size-5 text-muted-foreground hover:text-foreground"
                  aria-label={tMS("moveUp", { name: it.name })}
                >
                  ↑
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => move(id, 1)}
                  className="size-5 text-muted-foreground hover:text-foreground"
                  aria-label={tMS("moveDown", { name: it.name })}
                >
                  ↓
                </Button>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
