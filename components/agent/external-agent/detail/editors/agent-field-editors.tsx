"use client"

import { useId, type ComponentProps } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { DirectoryField } from "@/components/settings/common/directory-field"
import { StateIsolationField } from "@/components/agent/external-agent/add-agent/state-isolation-field"
import { PERMISSION_MODE_LABEL_KEY } from "@/components/settings/agent/agent-editor-dialog"
import type { ConnectionDraft, DraftErrors } from "@/components/settings/agent/inspector-draft"
import {
  adaptPermissionMode,
  supportedPermissionModes,
} from "@/lib/ai/agent/external/policy/permission-modes"
import type { AcpPermissionMode, ExternalAgentProtocol } from "@/types/agent/external-agent"

export interface FieldEditorProps {
  draft: ConnectionDraft
  onChange: <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => void
  errors?: DraftErrors
}

function DraftInput({
  draft,
  onChange,
  errors,
  field,
  label,
  hint,
  multiline = false,
  numeric = false,
  secret = false,
}: FieldEditorProps & {
  field: Exclude<keyof ConnectionDraft, "retryExponentialBackoff" | "stateIsolation">
  label: string
  hint?: string
  multiline?: boolean
  numeric?: boolean
  secret?: boolean
}) {
  const id = useId()
  const t = useTranslations("externalAgent.settings")
  const tManage = useTranslations("externalAgentManage.editor")
  const error = errors?.[field]
  const props = {
    id,
    value: draft[field],
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(field, event.target.value),
    "aria-invalid": Boolean(error),
    "aria-describedby":
      [error ? `${id}-error` : "", hint ? `${id}-hint` : ""].filter(Boolean).join(" ") || undefined,
  }
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea {...props} />
      ) : (
        <Input
          {...props}
          type={secret ? "password" : "text"}
          inputMode={numeric ? "numeric" : undefined}
          autoComplete={secret ? "new-password" : undefined}
        />
      )}
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error === "invalidIdleTimeout" ? tManage(error) : t(error)}
        </p>
      )}
    </div>
  )
}

export function NameDescriptionEditor(props: FieldEditorProps) {
  const t = useTranslations("externalAgent.settings")
  const tManage = useTranslations("externalAgentManage.editor")
  return (
    <div className="grid gap-4">
      <DraftInput {...props} field="name" label={t("agentName")} />
      <DraftInput {...props} field="description" label={tManage("description")} multiline />
    </div>
  )
}

export function ProcessEditor({
  field,
  allowLocalBrowse = true,
  ...props
}: FieldEditorProps & {
  field?: "processCommand" | "processArgs" | "processCwd"
  /** Host paths belong to the remote filesystem, not this desktop's picker. */
  allowLocalBrowse?: boolean
}) {
  const t = useTranslations("externalAgent.settings")
  return (
    <div className="grid gap-4">
      {(!field || field === "processCommand") && (
        <DraftInput {...props} field="processCommand" label={t("command")} />
      )}
      {(!field || field === "processArgs") && (
        <DraftInput {...props} field="processArgs" label={t("arguments")} />
      )}
      {(!field || field === "processCwd") &&
        (allowLocalBrowse ? (
          <div className="grid gap-2">
            <span className="text-sm font-medium">{t("workingDirectory")}</span>
            <DirectoryField
              value={props.draft.processCwd}
              onChange={(value) => props.onChange("processCwd", value)}
              onCommit={(value) => props.onChange("processCwd", value)}
              ariaLabel={t("workingDirectory")}
              browseLabel={t("codexSkillRootsBrowse")}
              placeholder={t("cwdPlaceholder")}
            />
          </div>
        ) : (
          <DraftInput {...props} field="processCwd" label={t("workingDirectory")} />
        ))}
    </div>
  )
}

export function NetworkEditor({
  field,
  hasSavedApiKey = false,
  ...props
}: FieldEditorProps & {
  field?: "networkEndpoint" | "networkApiKey"
  hasSavedApiKey?: boolean
}) {
  const t = useTranslations("externalAgent.settings")
  return (
    <div className="grid gap-4">
      {(!field || field === "networkEndpoint") && (
        <DraftInput {...props} field="networkEndpoint" label={t("endpoint")} />
      )}
      {(!field || field === "networkApiKey") && (
        <DraftInput
          {...props}
          field="networkApiKey"
          label={t("apiKey")}
          secret
          hint={hasSavedApiKey ? t("inspectorKeySaved") : undefined}
        />
      )}
    </div>
  )
}

export function PermissionModeEditor({
  protocol,
  value,
  onChange,
}: {
  protocol: ExternalAgentProtocol
  value: AcpPermissionMode
  onChange: (value: AcpPermissionMode) => void
}) {
  const t = useTranslations("externalAgent.settings")
  const id = useId()
  return (
    <RadioGroup
      value={adaptPermissionMode(value, protocol).mode}
      onValueChange={(next) =>
        onChange(adaptPermissionMode(next as AcpPermissionMode, protocol).mode)
      }
      aria-label={t("defaultPermissionMode")}
    >
      {supportedPermissionModes(protocol).map((mode) => (
        <Label
          key={mode}
          htmlFor={`${id}-${mode}`}
          className="flex min-h-11 items-center gap-3 font-normal"
        >
          <RadioGroupItem id={`${id}-${mode}`} value={mode} />
          {t(PERMISSION_MODE_LABEL_KEY[mode])}
        </Label>
      ))}
    </RadioGroup>
  )
}

export function AgentStateEditor(props: ComponentProps<typeof StateIsolationField>) {
  return <StateIsolationField {...props} />
}

export function SessionLimitEditor(props: FieldEditorProps) {
  const tInstance = useTranslations("externalAgent.instanceSection")
  const tManage = useTranslations("externalAgentManage.editor")
  return (
    <div className="grid gap-4">
      <DraftInput
        {...props}
        field="sessionLimit"
        label={tInstance("sessionLimit")}
        hint={tInstance("sessionLimitHint")}
        numeric
      />
      <DraftInput
        {...props}
        field="sessionIdleTimeout"
        label={tManage("idleTimeout")}
        hint={tManage("idleTimeoutHint")}
        numeric
      />
    </div>
  )
}

export function TimeoutRetryEditor(props: FieldEditorProps) {
  const t = useTranslations("externalAgent.settings")
  const id = useId()
  return (
    <div className="grid gap-4">
      <DraftInput {...props} field="timeoutMs" label={t("executionTimeoutMs")} numeric />
      <DraftInput {...props} field="retryMaxRetries" label={t("maxRetries")} numeric />
      <DraftInput {...props} field="retryDelayMs" label={t("retryDelayMs")} numeric />
      <DraftInput {...props} field="retryMaxDelayMs" label={t("maxRetryDelayMs")} numeric />
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id}>{t("backoffExponential")}</Label>
        <Switch
          id={id}
          checked={props.draft.retryExponentialBackoff}
          onCheckedChange={(value) => props.onChange("retryExponentialBackoff", value)}
        />
      </div>
    </div>
  )
}

export type WebSearchValue = "auto" | "native" | "unsupported"

export function WebSearchEditor({
  value,
  onChange,
}: {
  value: WebSearchValue
  onChange: (value: WebSearchValue) => void
}) {
  const t = useTranslations("externalAgent.settings")
  const id = useId()
  const options = [
    ["auto", "declaredWebSearchAuto"],
    ["native", "declaredWebSearchNative"],
    ["unsupported", "declaredWebSearchNone"],
  ] as const
  return (
    <RadioGroup
      value={value}
      onValueChange={(next) => onChange(next as WebSearchValue)}
      aria-label={t("declaredWebSearch")}
    >
      {options.map(([option, key]) => (
        <Label
          key={option}
          htmlFor={`${id}-${option}`}
          className="flex min-h-11 items-center gap-3 font-normal"
        >
          <RadioGroupItem id={`${id}-${option}`} value={option} />
          {t(key)}
        </Label>
      ))}
    </RadioGroup>
  )
}
