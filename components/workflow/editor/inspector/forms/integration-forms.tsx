"use client"

/**
 * Per-kind inspector config forms. Co-located in one file because each form
 * is small (5–20 lines of fields) and they all share the same shape — the
 * registry imports them as named exports.
 *
 * Forms intentionally do NOT validate at the field level; the orchestrator
 * runs the kind's zod schema (Phase 6) on save. Field-level errors land in
 * Phase 9 polish.
 */
import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, readNumber, readString, patchParam } from "./shared"
import { ExpressionField } from "./shared/expression-field"
import {
  CharacterPicker,
  SkillPicker,
  McpServerPicker,
  McpToolPicker,
  PluginPicker,
  TwinPicker,
  EntityPicker,
} from "./shared/entity-picker"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { PluginCapabilities } from "@/lib/plugin/api/plugin-capability-registry"
import { PiiGateField } from "./form-support"
import type { ConfigProps } from "./form-support"

// ── action.skill.invoke ───────────────────────────────────────────────────
export function SkillInvokeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.skillInvoke")
  const skillIds = readString(params, "skillIds")
  return (
    <FieldGroup>
      <Field
        label={t("skillIds.label")}
        htmlFor="si-ids"
        hint={t("skillIds.hint")}
        name="skillIds"
        required
      >
        <Input
          id="si-ids"
          value={skillIds}
          onChange={(e) => onChange(patchParam(params, "skillIds", e.target.value))}
          placeholder={t("skillIds.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.twin.rag ───────────────────────────────────────────────────────
export function TwinRagConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.twinRag")
  const twinId = readString(params, "twinId")
  const query = readString(params, "query")
  const topK = readNumber(params, "topK", 6)
  return (
    <FieldGroup>
      <Field label={t("twinId.label")} htmlFor="tr-twin" name="twinId" required>
        <TwinPicker
          id="tr-twin"
          value={twinId}
          onChange={(v) => onChange(patchParam(params, "twinId", v))}
        />
      </Field>
      <Field
        label={t("query.label")}
        htmlFor="tr-query"
        hint={t("query.hint")}
        name="query"
        required
      >
        <Textarea
          id="tr-query"
          value={query}
          onChange={(e) => onChange(patchParam(params, "query", e.target.value))}
          rows={3}
          placeholder={t("query.placeholder")}
        />
      </Field>
      <Field label={t("topK.label")} htmlFor="tr-topk" hint={t("topK.hint")} name="topK">
        <Input
          id="tr-topk"
          type="number"
          min={1}
          max={50}
          value={topK}
          onChange={(e) => onChange(patchParam(params, "topK", Number(e.target.value) || 1))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.skill.upsert ───────────────────────────────────────────────────
export function SkillUpsertConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.skillUpsert")
  const skillId = readString(params, "skillId")
  const name = readString(params, "name")
  const description = readString(params, "description")
  const content = readString(params, "content")
  const tagsRaw = readString(params, "tagsRaw")
  return (
    <FieldGroup>
      <Field label={t("skillId.label")} htmlFor="su-id" hint={t("skillId.hint")} name="skillId">
        <SkillPicker
          id="su-id"
          value={skillId}
          onChange={(v) => onChange(patchParam(params, "skillId", v))}
          allowEmpty
        />
      </Field>
      <Field label={t("name.label")} htmlFor="su-name" name="name" required>
        <Input
          id="su-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
          placeholder={t("name.placeholder")}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="su-desc" name="description">
        <Input
          id="su-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
        />
      </Field>
      <Field
        label={t("content.label")}
        htmlFor="su-content"
        hint={t("content.hint")}
        name="content"
        required
      >
        <Textarea
          id="su-content"
          value={content}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          rows={8}
          className="font-mono text-xs"
        />
      </Field>
      <Field label={t("tagsRaw.label")} htmlFor="su-tags" hint={t("tagsRaw.hint")} name="tagsRaw">
        <Input
          id="su-tags"
          value={tagsRaw}
          onChange={(e) => {
            const next = patchParam(params, "tagsRaw", e.target.value) as Record<string, unknown>
            ;(next as Record<string, unknown>).tags = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
            onChange(next)
          }}
          placeholder={t("tagsRaw.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.twin.ingest ────────────────────────────────────────────────────
export function TwinIngestConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.twinIngest")
  const twinId = readString(params, "twinId")
  const sourceMode = readString(params, "sourceMode", "paste")
  const format = readString(params, "format", "markdown")
  const content = readString(params, "content")
  const url = readString(params, "url")
  const title = readString(params, "title")
  return (
    <FieldGroup>
      <Field label={t("twinId.label")} htmlFor="ti-twin" name="twinId" required>
        <TwinPicker
          id="ti-twin"
          value={twinId}
          onChange={(v) => onChange(patchParam(params, "twinId", v))}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("sourceMode.label")} htmlFor="ti-mode" name="sourceMode">
          <Select
            value={sourceMode}
            onValueChange={(v) => onChange(patchParam(params, "sourceMode", v))}
          >
            <SelectTrigger id="ti-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paste">{t("sourceMode.options.paste")}</SelectItem>
              <SelectItem value="fetch">{t("sourceMode.options.fetch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("format.label")} htmlFor="ti-fmt" name="format">
          <Select value={format} onValueChange={(v) => onChange(patchParam(params, "format", v))}>
            <SelectTrigger id="ti-fmt">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="markdown">{t("format.options.markdown")}</SelectItem>
              <SelectItem value="text">{t("format.options.text")}</SelectItem>
              <SelectItem value="code">{t("format.options.code")}</SelectItem>
              <SelectItem value="chat">{t("format.options.chat")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={t("title.label")} htmlFor="ti-title" name="title">
        <Input
          id="ti-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
        />
      </Field>
      {sourceMode === "fetch" ? (
        <Field label={t("url.label")} htmlFor="ti-url" hint={t("url.hint")} name="url" required>
          <Input
            id="ti-url"
            value={url}
            onChange={(e) => onChange(patchParam(params, "url", e.target.value))}
            placeholder={t("url.placeholder")}
          />
        </Field>
      ) : (
        <Field
          label={t("content.label")}
          htmlFor="ti-content"
          hint={t("content.hint")}
          name="content"
          required
        >
          <Textarea
            id="ti-content"
            value={content}
            onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
            rows={8}
            className="font-mono text-xs"
          />
        </Field>
      )}
    </FieldGroup>
  )
}

// ── action.memory.recall ──────────────────────────────────────────────────
export function MemoryRecallConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.memoryRecall")
  const query = readString(params, "query")
  const scope = readString(params, "scope", "global")
  const characterId = readString(params, "characterId")
  const projectId = readString(params, "projectId")
  const agentId = readString(params, "agentId")
  const branch = readString(params, "branch")
  const path = readString(params, "path")
  const topK = readNumber(params, "topK", 6)
  return (
    <FieldGroup>
      <Field label={t("query.label")} htmlFor="mr-query" name="query" required>
        <ExpressionField
          id="mr-query"
          value={query}
          onChange={(v) => onChange(patchParam(params, "query", v))}
          multiline
          rows={2}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("scope.label")} htmlFor="mr-scope" name="scope">
          <Select value={scope} onValueChange={(v) => onChange(patchParam(params, "scope", v))}>
            <SelectTrigger id="mr-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">{t("scope.global")}</SelectItem>
              <SelectItem value="workspace">{t("scope.workspace")}</SelectItem>
              <SelectItem value="character">{t("scope.character")}</SelectItem>
              <SelectItem value="agent">{t("scope.agent")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("topK.label")} htmlFor="mr-topk" name="topK">
          <Input
            id="mr-topk"
            type="number"
            min={1}
            max={50}
            value={topK}
            onChange={(e) => onChange(patchParam(params, "topK", Number(e.target.value) || 1))}
          />
        </Field>
      </div>
      {scope === "character" ? (
        <Field label={t("characterId.label")} htmlFor="mr-char" name="characterId" required>
          <CharacterPicker
            id="mr-char"
            value={characterId}
            onChange={(v) => onChange(patchParam(params, "characterId", v))}
          />
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("projectId.label")}
          htmlFor="mr-project"
          name="projectId"
          required={scope === "workspace"}
        >
          <ExpressionField
            id="mr-project"
            value={projectId}
            onChange={(v) => onChange(patchParam(params, "projectId", v))}
          />
        </Field>
        <Field
          label={t("agentId.label")}
          htmlFor="mr-agent"
          name="agentId"
          required={scope === "agent"}
        >
          <ExpressionField
            id="mr-agent"
            value={agentId}
            onChange={(v) => onChange(patchParam(params, "agentId", v))}
          />
        </Field>
        <Field label={t("branch.label")} htmlFor="mr-branch" name="branch">
          <ExpressionField
            id="mr-branch"
            value={branch}
            onChange={(v) => onChange(patchParam(params, "branch", v))}
          />
        </Field>
        <Field label={t("path.label")} htmlFor="mr-path" name="path">
          <ExpressionField
            id="mr-path"
            value={path}
            onChange={(v) => onChange(patchParam(params, "path", v))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── action.memory.store ───────────────────────────────────────────────────
export function MemoryStoreConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.memoryStore")
  const text = readString(params, "text")
  const scope = readString(params, "scope", "global")
  const characterId = readString(params, "characterId")
  const projectId = readString(params, "projectId")
  const agentId = readString(params, "agentId")
  const branch = readString(params, "branch")
  const pathPattern = readString(params, "pathPattern")
  const importance = readNumber(params, "importance", 7)
  const piiGate = readString(params, "piiGate", "block")
  return (
    <FieldGroup>
      <Field label={t("text.label")} htmlFor="ms-text" hint={t("text.hint")} name="text" required>
        <ExpressionField
          id="ms-text"
          value={text}
          onChange={(v) => onChange(patchParam(params, "text", v))}
          multiline
          rows={3}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t("scope.label")} htmlFor="ms-scope" name="scope">
          <Select value={scope} onValueChange={(v) => onChange(patchParam(params, "scope", v))}>
            <SelectTrigger id="ms-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">{t("scope.global")}</SelectItem>
              <SelectItem value="workspace">{t("scope.workspace")}</SelectItem>
              <SelectItem value="character">{t("scope.character")}</SelectItem>
              <SelectItem value="agent">{t("scope.agent")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={t("importance.label")}
          htmlFor="ms-imp"
          hint={t("importance.hint")}
          name="importance"
        >
          <Input
            id="ms-imp"
            type="number"
            min={1}
            max={10}
            value={importance}
            onChange={(e) =>
              onChange(patchParam(params, "importance", Number(e.target.value) || 1))
            }
          />
        </Field>
      </div>
      {scope === "character" ? (
        <Field label={t("characterId.label")} htmlFor="ms-char" name="characterId" required>
          <CharacterPicker
            id="ms-char"
            value={characterId}
            onChange={(v) => onChange(patchParam(params, "characterId", v))}
          />
        </Field>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <Field
          label={t("projectId.label")}
          htmlFor="ms-project"
          name="projectId"
          required={scope === "workspace"}
        >
          <ExpressionField
            id="ms-project"
            value={projectId}
            onChange={(v) => onChange(patchParam(params, "projectId", v))}
          />
        </Field>
        <Field
          label={t("agentId.label")}
          htmlFor="ms-agent"
          name="agentId"
          required={scope === "agent"}
        >
          <ExpressionField
            id="ms-agent"
            value={agentId}
            onChange={(v) => onChange(patchParam(params, "agentId", v))}
          />
        </Field>
        <Field label={t("branch.label")} htmlFor="ms-branch" name="branch">
          <ExpressionField
            id="ms-branch"
            value={branch}
            onChange={(v) => onChange(patchParam(params, "branch", v))}
          />
        </Field>
        <Field label={t("pathPattern.label")} htmlFor="ms-path" name="pathPattern">
          <ExpressionField
            id="ms-path"
            value={pathPattern}
            onChange={(v) => onChange(patchParam(params, "pathPattern", v))}
          />
        </Field>
      </div>
      <PiiGateField id="ms-pii" value={piiGate} params={params} onChange={onChange} t={t} />
    </FieldGroup>
  )
}

// ── action.mcp.invokeTool ─────────────────────────────────────────────────
export function McpInvokeToolConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.mcpInvokeTool")
  const serverId = readString(params, "serverId")
  const toolName = readString(params, "toolName")
  const argsJson = readString(params, "argsJson", "{}")
  const piiGate = readString(params, "piiGate", "block")
  return (
    <FieldGroup>
      <Field label={t("serverId.label")} htmlFor="mi-server" name="serverId" required>
        <McpServerPicker
          id="mi-server"
          value={serverId}
          onChange={(v) => onChange(patchParam(params, "serverId", v))}
        />
      </Field>
      <Field label={t("toolName.label")} htmlFor="mi-tool" name="toolName" required>
        <McpToolPicker
          id="mi-tool"
          serverId={serverId}
          value={toolName}
          onChange={(v) => onChange(patchParam(params, "toolName", v))}
        />
      </Field>
      <Field
        label={t("argsJson.label")}
        htmlFor="mi-args"
        hint={t("argsJson.hint")}
        name="argsJson"
      >
        <Textarea
          id="mi-args"
          value={argsJson}
          onChange={(e) => {
            const next = patchParam(params, "argsJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object") {
                ;(next as Record<string, unknown>).args = parsed
              }
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
      <PiiGateField id="mi-pii" value={piiGate} params={params} onChange={onChange} t={t} />
    </FieldGroup>
  )
}

// ── action.plugin.invoke ──────────────────────────────────────────────────
// Two dispatch modes mirroring the executor (`lib/workflow/nodes/built-ins.ts`):
//  - "tool": pick an enabled plugin + one of its registered agent tools from
//    dropdowns fed by the capability enumeration API.
//  - "task": legacy free-text `workflow.task` id (ADR-0017 back-compat).
export function PluginInvokeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.pluginInvoke")
  const pluginId = readString(params, "pluginId")
  const toolName = readString(params, "toolName")
  const taskId = readString(params, "taskId")
  const argsJson = readString(params, "argsJson", "{}")
  const piiGate = readString(params, "piiGate", "block")
  // Mode inference mirrors the executor: explicit discriminator wins, then
  // whichever target field a persisted node carries; new nodes default to
  // the tool path.
  const storedMode = readString(params, "mode")
  const mode =
    storedMode === "task" || storedMode === "tool"
      ? storedMode
      : toolName
        ? "tool"
        : taskId
          ? "task"
          : "tool"

  // Capability snapshot for the tool-mode dropdowns. Re-fetched whenever the
  // plugin runtime store mutates (enable/disable/tool registration).
  const [capabilities, setCapabilities] = useState<PluginCapabilities[]>([])
  const pluginsRevision = usePluginStore((s) => s.plugins)
  useEffect(() => {
    if (mode !== "tool") return
    let cancelled = false
    import("@/lib/plugin/api/plugin-capability-registry")
      .then(({ listPluginCapabilities }) => listPluginCapabilities())
      .then((all) => {
        if (!cancelled) setCapabilities(all)
      })
      .catch(() => {
        // Capability sources unavailable (early boot) — pickers stay empty.
      })
    return () => {
      cancelled = true
    }
  }, [mode, pluginsRevision])

  const pluginOptions = capabilities
    .filter((c) => c.enabled && c.tools.length > 0)
    .map((c) => ({ value: c.pluginId, label: c.pluginId }))
  const selectedTools = capabilities.find((c) => c.pluginId === pluginId)?.tools ?? []
  const toolOptions = selectedTools.map((tool) => ({ value: tool.id, label: tool.label }))
  const selectedToolSchema = selectedTools.find((tool) => tool.id === toolName)?.argsSchema
  const schemaFields =
    selectedToolSchema && typeof selectedToolSchema.properties === "object"
      ? Object.keys(selectedToolSchema.properties as Record<string, unknown>)
      : []

  return (
    <FieldGroup>
      <Field label={t("mode.label")} htmlFor="pi-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="pi-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tool">{t("mode.options.tool")}</SelectItem>
            <SelectItem value="task">{t("mode.options.task")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("pluginId.label")} htmlFor="pi-plug" name="pluginId" required>
        {mode === "tool" ? (
          <EntityPicker
            id="pi-plug"
            value={pluginId}
            onChange={(v) => onChange(patchParam(params, "pluginId", v))}
            options={pluginOptions}
            placeholder={t("pluginId.toolPlaceholder")}
            allowExpression
          />
        ) : (
          <PluginPicker
            id="pi-plug"
            value={pluginId}
            onChange={(v) => onChange(patchParam(params, "pluginId", v))}
          />
        )}
      </Field>
      {mode === "tool" ? (
        <Field label={t("toolName.label")} htmlFor="pi-tool" name="toolName" required>
          <EntityPicker
            id="pi-tool"
            value={toolName}
            onChange={(v) => onChange(patchParam(params, "toolName", v))}
            options={toolOptions}
            placeholder={pluginId ? t("toolName.placeholder") : t("toolName.empty")}
            allowExpression
          />
        </Field>
      ) : (
        <Field label={t("taskId.label")} htmlFor="pi-task" name="taskId" required>
          <Input
            id="pi-task"
            value={taskId}
            onChange={(e) => onChange(patchParam(params, "taskId", e.target.value))}
            placeholder={t("taskId.placeholder")}
          />
        </Field>
      )}
      <Field
        label={t("argsJson.label")}
        htmlFor="pi-args"
        hint={
          mode === "tool" && schemaFields.length > 0
            ? t("argsJson.toolHint", { fields: schemaFields.join(", ") })
            : t("argsJson.hint")
        }
        name="argsJson"
      >
        <Textarea
          id="pi-args"
          value={argsJson}
          onChange={(e) => {
            const next = patchParam(params, "argsJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object") {
                ;(next as Record<string, unknown>).args = parsed
              }
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
      <PiiGateField id="pi-pii" value={piiGate} params={params} onChange={onChange} t={t} />
    </FieldGroup>
  )
}
