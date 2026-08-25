"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
  deleteProjectEnvironment,
  listProjectEnvironments,
  putProjectEnvironment,
} from "@/lib/db/project-environments"
import { executeProjectEnvironment } from "@/lib/project-environment/executor"
import { ProjectEnvironmentRepoConfig } from "./project-environment-repo-config"
import { useProjectStore } from "@/stores/project/project-store"
import type {
  ProjectEnvironment,
  ProjectEnvironmentAction,
  ProjectEnvironmentScript,
} from "@/types/project-environment"

interface VariableRow {
  name: string
  value: string
}

interface SecretRow {
  variable: string
  keyringRef: string
}

function emptyEnvironment(projectId: string): ProjectEnvironment {
  const now = Date.now()
  return {
    id: `project-environment:${crypto.randomUUID()}`,
    projectId,
    name: "",
    isEnabled: true,
    setupScript: { default: "", byOs: {} },
    actions: [],
    variables: {},
    keyringReferences: [],
    createdAt: now,
    updatedAt: now,
  }
}

function ScriptFields({
  value,
  onChange,
  ids,
}: {
  value: ProjectEnvironmentScript
  onChange(value: ProjectEnvironmentScript): void
  ids: string
}) {
  const t = useTranslations("projectEnvironment")
  const updateOs = (os: "macos" | "windows" | "linux", script: string) =>
    onChange({ ...value, byOs: { ...value.byOs, [os]: script } })
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      <Textarea
        id={`${ids}-default`}
        value={value.default}
        onChange={(event) => onChange({ ...value, default: event.target.value })}
        placeholder={t("setupPlaceholder")}
        aria-label={t("setup")}
        className="sm:col-span-2"
      />
      {(["macos", "windows", "linux"] as const).map((os) => (
        <Input
          key={os}
          id={`${ids}-${os}`}
          value={value.byOs?.[os] ?? ""}
          onChange={(event) => updateOs(os, event.target.value)}
          placeholder={t(os)}
          aria-label={t(os)}
        />
      ))}
    </div>
  )
}

export function ProjectEnvironmentManager({
  projectId,
  executionRoot,
  scope,
  selectedEnvironmentId,
  onSelectedEnvironmentChange,
}: {
  projectId: string
  executionRoot: string
  scope: "local" | "managedWorktree"
  selectedEnvironmentId?: string
  onSelectedEnvironmentChange?(environmentId: string | undefined): Promise<void> | void
}) {
  const t = useTranslations("projectEnvironment")
  const [environments, setEnvironments] = useState<ProjectEnvironment[]>([])
  const [draft, setDraft] = useState<ProjectEnvironment | null>(null)
  const [variables, setVariables] = useState<VariableRow[]>([])
  const [secrets, setSecrets] = useState<SecretRow[]>([])
  const [isDefault, setIsDefault] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null)
  const defaultEnvironmentId = useProjectStore(
    (state) => state.projects.find((project) => project.id === projectId)?.defaultEnvironmentId
  )

  const selectDraft = useCallback(
    (environment: ProjectEnvironment | null) => {
      setDraft(environment ? structuredClone(environment) : null)
      setVariables(
        environment
          ? Object.entries(environment.variables).map(([name, value]) => ({ name, value }))
          : []
      )
      setSecrets(environment?.keyringReferences.map((reference) => ({ ...reference })) ?? [])
      setIsDefault(Boolean(environment && environment.id === defaultEnvironmentId))
    },
    [defaultEnvironmentId]
  )

  const load = async (preferredId = selectedEnvironmentId) => {
    const rows = await listProjectEnvironments(projectId)
    setEnvironments(rows)
    const selected = rows.find((row) => row.id === preferredId) ?? rows[0] ?? null
    selectDraft(selected)
  }

  useEffect(() => {
    let cancelled = false
    void listProjectEnvironments(projectId)
      .then((rows) => {
        if (cancelled) return
        setEnvironments(rows)
        const selected = rows.find((row) => row.id === selectedEnvironmentId) ?? rows[0] ?? null
        selectDraft(selected)
      })
      .catch(() => {
        if (!cancelled) setEnvironments([])
      })
    return () => {
      cancelled = true
    }
    // The default id is intentionally included so the checkbox follows project updates.
  }, [projectId, selectedEnvironmentId, defaultEnvironmentId, selectDraft])

  const save = async () => {
    if (!draft?.name.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      const now = Date.now()
      const next: ProjectEnvironment = {
        ...draft,
        name: draft.name.trim(),
        variables: Object.fromEntries(
          variables.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value])
        ),
        keyringReferences: secrets
          .filter((row) => row.variable.trim() && row.keyringRef.trim())
          .map((row) => ({ variable: row.variable.trim(), keyringRef: row.keyringRef.trim() })),
        updatedAt: now,
      }
      await putProjectEnvironment(next)
      useProjectStore.getState().updateProject(projectId, {
        defaultEnvironmentId: isDefault
          ? next.id
          : defaultEnvironmentId === next.id
            ? undefined
            : defaultEnvironmentId,
      })
      await onSelectedEnvironmentChange?.(next.id)
      await load(next.id)
      setMessage({ kind: "success", text: t("saved") })
    } catch (cause) {
      setMessage({
        kind: "error",
        text: t("failure", { message: cause instanceof Error ? cause.message : String(cause) }),
      })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!draft) return
    setBusy(true)
    try {
      await deleteProjectEnvironment(draft.id)
      if (defaultEnvironmentId === draft.id) {
        useProjectStore.getState().updateProject(projectId, { defaultEnvironmentId: undefined })
      }
      if (selectedEnvironmentId === draft.id) await onSelectedEnvironmentChange?.(undefined)
      await load(undefined)
      setMessage({ kind: "success", text: t("deleted") })
    } finally {
      setBusy(false)
    }
  }

  const execute = async (actionId?: string, bypassOnFailure = false) => {
    if (!draft) return
    setBusy(true)
    setMessage(null)
    const result = await executeProjectEnvironment({
      environment: draft,
      executionRoot,
      scope,
      surface: "interactive",
      actionId,
      bypassOnFailure,
    })
    setMessage(
      result.success
        ? { kind: "success", text: t("success") }
        : { kind: "error", text: t("failure", { message: result.error ?? "unknown" }) }
    )
    setBusy(false)
    await load(draft.id)
  }

  const updateAction = (index: number, action: ProjectEnvironmentAction) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            actions: current.actions.map((item, itemIndex) =>
              itemIndex === index ? action : item
            ),
          }
        : current
    )

  return (
    <div
      className="space-y-3 rounded-md border bg-muted/20 p-3"
      data-testid="project-environment-manager"
    >
      <div>
        <p className="text-xs font-medium">{t("title")}</p>
        <p className="text-[10px] text-muted-foreground">{t("description")}</p>
      </div>
      {/* Above the device-local editor on purpose: what the repository ships is
          the thing the user did not write, and it decides what the local
          environment is merged on top of. */}
      <ProjectEnvironmentRepoConfig projectId={projectId} executionRoot={executionRoot} />
      <div className="flex gap-2">
        <Select
          value={draft?.id ?? "__none__"}
          onValueChange={(id) => selectDraft(environments.find((row) => row.id === id) ?? null)}
        >
          <SelectTrigger aria-label={t("select")} className="flex-1">
            <SelectValue placeholder={t("none")} />
          </SelectTrigger>
          <SelectContent>
            {environments.map((environment) => (
              <SelectItem key={environment.id} value={environment.id}>
                {environment.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => selectDraft(emptyEnvironment(projectId))}
        >
          <PlusIcon className="size-3.5" />
          {t("create")}
        </Button>
      </div>

      {draft && (
        <div className="space-y-3">
          <Input
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            placeholder={t("name")}
            aria-label={t("name")}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label className="flex items-center gap-2 text-xs">
              <Switch
                checked={draft.isEnabled}
                onCheckedChange={(checked) => setDraft({ ...draft, isEnabled: checked })}
              />
              {t("enabled")}
            </Label>
            <Label className="flex items-center gap-2 text-xs">
              <Checkbox
                checked={isDefault}
                onCheckedChange={(checked) => setIsDefault(Boolean(checked))}
              />
              {t("default")}
            </Label>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("setup")}</Label>
            <ScriptFields
              value={draft.setupScript}
              onChange={(setupScript) => setDraft({ ...draft, setupScript })}
              ids={`${draft.id}-setup`}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("variables")}</Label>
            <p className="text-[10px] text-muted-foreground">{t("plainWarning")}</p>
            {variables.map((row, index) => (
              <div key={index} className="flex gap-1.5">
                <Input
                  value={row.name}
                  aria-label={t("variableName")}
                  placeholder={t("variableName")}
                  onChange={(event) =>
                    setVariables((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, name: event.target.value } : item
                      )
                    )
                  }
                />
                <Input
                  value={row.value}
                  aria-label={t("variableValue")}
                  placeholder={t("variableValue")}
                  onChange={(event) =>
                    setVariables((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, value: event.target.value } : item
                      )
                    )
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("remove")}
                  onClick={() =>
                    setVariables((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setVariables((current) => [...current, { name: "", value: "" }])}
            >
              {t("addVariable")}
            </Button>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">{t("secrets")}</Label>
            {secrets.map((row, index) => (
              <div key={index} className="flex gap-1.5">
                <Input
                  value={row.variable}
                  aria-label={t("secretVariable")}
                  placeholder={t("secretVariable")}
                  onChange={(event) =>
                    setSecrets((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, variable: event.target.value } : item
                      )
                    )
                  }
                />
                <Input
                  value={row.keyringRef}
                  aria-label={t("secretReference")}
                  placeholder={t("secretReference")}
                  onChange={(event) =>
                    setSecrets((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index ? { ...item, keyringRef: event.target.value } : item
                      )
                    )
                  }
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={t("remove")}
                  onClick={() =>
                    setSecrets((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setSecrets((current) => [...current, { variable: "", keyringRef: "" }])
              }
            >
              {t("addSecret")}
            </Button>
          </div>

          <div className="space-y-2">
            <Label className="text-xs">{t("actions")}</Label>
            {draft.actions.map((action, index) => (
              <div key={action.id} className="space-y-2 rounded-md border p-2">
                <div className="flex gap-1.5">
                  <Input
                    value={action.name}
                    aria-label={t("actionName")}
                    placeholder={t("actionName")}
                    onChange={(event) =>
                      updateAction(index, { ...action, name: event.target.value })
                    }
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("remove")}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        actions: draft.actions.filter((_, itemIndex) => itemIndex !== index),
                      })
                    }
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
                <ScriptFields
                  value={action.script}
                  onChange={(script) => updateAction(index, { ...action, script })}
                  ids={`${draft.id}-action-${action.id}`}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void execute(action.id)}
                >
                  {t("runAction", { name: action.name || t("actionName") })}
                </Button>
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setDraft({
                  ...draft,
                  actions: [
                    ...draft.actions,
                    {
                      id: `action:${crypto.randomUUID()}`,
                      name: "",
                      script: { default: "", byOs: {} },
                    },
                  ],
                })
              }
            >
              {t("addAction")}
            </Button>
          </div>

          {draft.lastInitialization && (
            <p className="text-[11px] text-muted-foreground">
              {t("status", { status: draft.lastInitialization.status })}
            </p>
          )}
          <p className="text-[10px] text-muted-foreground">{t("scheduledNoBypass")}</p>
          {message && (
            <p
              role={message.kind === "error" ? "alert" : "status"}
              className={
                message.kind === "error" ? "text-xs text-destructive" : "text-xs text-emerald-600"
              }
            >
              {message.text}
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" disabled={busy || !draft.name.trim()} onClick={() => void save()}>
              {t("save")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void execute()}>
              {draft.lastInitialization?.status === "failed" ? t("retry") : t("runSetup")}
            </Button>
            {draft.lastInitialization?.status === "failed" && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void execute(undefined, true)}
              >
                {t("bypass")}
              </Button>
            )}
            {environments.some((row) => row.id === draft.id) && (
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>
                {t("delete")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
