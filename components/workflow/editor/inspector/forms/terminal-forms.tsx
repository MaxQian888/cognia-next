"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Field,
  FieldGroup,
  readBoolean,
  readNumber,
  readString,
  patchParam,
  FieldRow,
} from "./shared"
import { TerminalUnattendedFields } from "./form-support"
import type { ConfigProps, TranslationFn } from "./form-support"

// ── action.system.terminal ────────────────────────────────────────────────
// Wave 3 — config form for the integrated terminal action. Mirrors the
// executor's input contract in `lib/workflow/nodes/terminal.ts`.
/**
 * One argument per line. Deliberately NOT comma-separated like the tool lists
 * elsewhere in the inspector: a shell argument may legitimately contain a
 * comma, and the executors either append these to the command line or spread
 * them as argv, so a wrong split silently changes what runs.
 */
function ArgsField({ id, params, onChange, t }: ConfigProps & { id: string; t: TranslationFn }) {
  const text = Array.isArray(params.args) ? (params.args as string[]).join("\n") : ""
  return (
    <Field label={t("args.label")} htmlFor={id} hint={t("args.hint")} name="args">
      <Textarea
        id={id}
        value={text}
        onChange={(e) => {
          const list = e.target.value
            .split("\n")
            .map((v) => v.trim())
            .filter(Boolean)
          onChange(patchParam(params, "args", list.length > 0 ? list : undefined))
        }}
        rows={2}
        className="font-mono text-xs"
        placeholder={t("args.placeholder")}
      />
    </Field>
  )
}

export function SystemTerminalConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.systemTerminal")
  const command = readString(params, "command")
  const cwd = readString(params, "cwd")
  const shell = readString(params, "shell")
  const tabId = readString(params, "tabId")
  const timeoutSec = readNumber(params, "timeoutSec", 60)
  const onFailure = readString(params, "onFailure", "throw")
  const unattended = readBoolean(params, "unattended", false)
  const onAskVerdict = readString(params, "onAskVerdict", "fail")
  return (
    <FieldGroup>
      <Field
        label={t("command.label")}
        htmlFor="term-command"
        hint={t("command.hint")}
        name="command"
        required
      >
        <Textarea
          id="term-command"
          value={command}
          onChange={(e) => onChange(patchParam(params, "command", e.target.value))}
          placeholder={t("command.placeholder")}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <ArgsField id="term-args" params={params} onChange={onChange} t={t} />
      <FieldRow className="gap-2">
        <Field label={t("cwd.label")} htmlFor="term-cwd" hint={t("cwd.hint")} name="cwd">
          <Input
            id="term-cwd"
            value={cwd}
            onChange={(e) => onChange(patchParam(params, "cwd", e.target.value))}
            placeholder={t("cwd.placeholder")}
          />
        </Field>
        <Field label={t("shell.label")} htmlFor="term-shell" hint={t("shell.hint")} name="shell">
          <Input
            id="term-shell"
            value={shell}
            onChange={(e) => onChange(patchParam(params, "shell", e.target.value))}
            placeholder={t("shell.placeholder")}
          />
        </Field>
      </FieldRow>
      <Field label={t("tabId.label")} htmlFor="term-tab" hint={t("tabId.hint")} name="tabId">
        <Input
          id="term-tab"
          value={tabId}
          onChange={(e) => onChange(patchParam(params, "tabId", e.target.value))}
          placeholder={t("tabId.placeholder")}
        />
      </Field>
      <FieldRow className="gap-2">
        <Field
          label={t("timeoutSec.label")}
          htmlFor="term-timeout"
          hint={t("timeoutSec.hint")}
          name="timeoutSec"
        >
          <Input
            id="term-timeout"
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "timeoutSec",
                  Math.max(5, Math.min(600, Number(e.target.value) || 60))
                )
              )
            }
          />
        </Field>
        <Field
          label={t("onFailure.label")}
          htmlFor="term-onfail"
          hint={t("onFailure.hint")}
          name="onFailure"
        >
          <Select
            value={onFailure}
            onValueChange={(v) => onChange(patchParam(params, "onFailure", v))}
          >
            <SelectTrigger id="term-onfail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="throw">{t("onFailure.options.throw")}</SelectItem>
              <SelectItem value="branch">{t("onFailure.options.branch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>
      <TerminalUnattendedFields
        params={params}
        onChange={onChange}
        unattended={unattended}
        onAskVerdict={onAskVerdict}
        idPrefix="term"
      />
    </FieldGroup>
  )
}

// ── action.terminal.session.* ───────────────────────────────────────────────
export function TerminalSessionOpenConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalSessionOpen")
  const cwd = readString(params, "cwd")
  const shell = readString(params, "shell")
  const unattended = readBoolean(params, "unattended", false)
  return (
    <FieldGroup>
      <FieldRow className="gap-2">
        <Field label={t("cwd.label")} htmlFor="tsopen-cwd" hint={t("cwd.hint")} name="cwd">
          <Input
            id="tsopen-cwd"
            value={cwd}
            onChange={(e) => onChange(patchParam(params, "cwd", e.target.value))}
            placeholder={t("cwd.placeholder")}
          />
        </Field>
        <Field label={t("shell.label")} htmlFor="tsopen-shell" hint={t("shell.hint")} name="shell">
          <Input
            id="tsopen-shell"
            value={shell}
            onChange={(e) => onChange(patchParam(params, "shell", e.target.value))}
            placeholder={t("shell.placeholder")}
          />
        </Field>
      </FieldRow>
      <div className="flex items-center justify-between gap-3">
        <Field
          label={t("unattended.label")}
          htmlFor="tsopen-unattended"
          hint={t("unattended.hint")}
          name="unattended"
        >
          <Switch
            id="tsopen-unattended"
            checked={unattended}
            onCheckedChange={(v) => onChange(patchParam(params, "unattended", v))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

export function TerminalSessionRunConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalSessionRun")
  const sessionId = readString(params, "sessionId")
  const command = readString(params, "command")
  const timeoutSec = readNumber(params, "timeoutSec", 60)
  const onFailure = readString(params, "onFailure", "throw")
  const onAskVerdict = readString(params, "onAskVerdict", "fail")
  return (
    <FieldGroup>
      <Field
        label={t("sessionId.label")}
        htmlFor="tsrun-session"
        hint={t("sessionId.hint")}
        name="sessionId"
        required
      >
        <Input
          id="tsrun-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
          placeholder={t("sessionId.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("command.label")}
        htmlFor="tsrun-command"
        hint={t("command.hint")}
        name="command"
        required
      >
        <Textarea
          id="tsrun-command"
          value={command}
          onChange={(e) => onChange(patchParam(params, "command", e.target.value))}
          placeholder={t("command.placeholder")}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
      <ArgsField id="tsrun-args" params={params} onChange={onChange} t={t} />
      <FieldRow className="gap-2">
        <Field
          label={t("timeoutSec.label")}
          htmlFor="tsrun-timeout"
          hint={t("timeoutSec.hint")}
          name="timeoutSec"
        >
          <Input
            id="tsrun-timeout"
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "timeoutSec",
                  Math.max(5, Math.min(600, Number(e.target.value) || 60))
                )
              )
            }
          />
        </Field>
        <Field
          label={t("onFailure.label")}
          htmlFor="tsrun-onfail"
          hint={t("onFailure.hint")}
          name="onFailure"
        >
          <Select
            value={onFailure}
            onValueChange={(v) => onChange(patchParam(params, "onFailure", v))}
          >
            <SelectTrigger id="tsrun-onfail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="throw">{t("onFailure.options.throw")}</SelectItem>
              <SelectItem value="branch">{t("onFailure.options.branch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>
      <Field
        label={t("onAskVerdict.label")}
        htmlFor="tsrun-askverdict"
        hint={t("onAskVerdict.hint")}
        name="onAskVerdict"
      >
        <Select
          value={onAskVerdict}
          onValueChange={(v) => onChange(patchParam(params, "onAskVerdict", v))}
        >
          <SelectTrigger id="tsrun-askverdict">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fail">{t("onAskVerdict.options.fail")}</SelectItem>
            <SelectItem value="consent">{t("onAskVerdict.options.consent")}</SelectItem>
            <SelectItem value="run">{t("onAskVerdict.options.run")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

export function TerminalSessionCloseConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalSessionClose")
  const sessionId = readString(params, "sessionId")
  return (
    <FieldGroup>
      <Field
        label={t("sessionId.label")}
        htmlFor="tsclose-session"
        hint={t("sessionId.hint")}
        name="sessionId"
        required
      >
        <Input
          id="tsclose-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
          placeholder={t("sessionId.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.terminal.script ──────────────────────────────────────────────────
export function TerminalScriptConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalScript")
  const scriptPath = readString(params, "scriptPath")
  const interpreter = readString(params, "interpreter")
  const cwd = readString(params, "cwd")
  const timeoutSec = readNumber(params, "timeoutSec", 60)
  const onFailure = readString(params, "onFailure", "throw")
  const unattended = readBoolean(params, "unattended", false)
  const onAskVerdict = readString(params, "onAskVerdict", "fail")
  return (
    <FieldGroup>
      <Field
        label={t("scriptPath.label")}
        htmlFor="tscript-path"
        hint={t("scriptPath.hint")}
        name="scriptPath"
        required
      >
        <Input
          id="tscript-path"
          value={scriptPath}
          onChange={(e) => onChange(patchParam(params, "scriptPath", e.target.value))}
          placeholder={t("scriptPath.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <ArgsField id="tscript-args" params={params} onChange={onChange} t={t} />
      <FieldRow className="gap-2">
        <Field
          label={t("interpreter.label")}
          htmlFor="tscript-interp"
          hint={t("interpreter.hint")}
          name="interpreter"
        >
          <Input
            id="tscript-interp"
            value={interpreter}
            onChange={(e) => onChange(patchParam(params, "interpreter", e.target.value))}
            placeholder={t("interpreter.placeholder")}
          />
        </Field>
        <Field label={t("cwd.label")} htmlFor="tscript-cwd" hint={t("cwd.hint")} name="cwd">
          <Input
            id="tscript-cwd"
            value={cwd}
            onChange={(e) => onChange(patchParam(params, "cwd", e.target.value))}
            placeholder={t("cwd.placeholder")}
          />
        </Field>
      </FieldRow>
      <FieldRow className="gap-2">
        <Field
          label={t("timeoutSec.label")}
          htmlFor="tscript-timeout"
          hint={t("timeoutSec.hint")}
          name="timeoutSec"
        >
          <Input
            id="tscript-timeout"
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "timeoutSec",
                  Math.max(5, Math.min(600, Number(e.target.value) || 60))
                )
              )
            }
          />
        </Field>
        <Field
          label={t("onFailure.label")}
          htmlFor="tscript-onfail"
          hint={t("onFailure.hint")}
          name="onFailure"
        >
          <Select
            value={onFailure}
            onValueChange={(v) => onChange(patchParam(params, "onFailure", v))}
          >
            <SelectTrigger id="tscript-onfail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="throw">{t("onFailure.options.throw")}</SelectItem>
              <SelectItem value="branch">{t("onFailure.options.branch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>
      <TerminalUnattendedFields
        params={params}
        onChange={onChange}
        unattended={unattended}
        onAskVerdict={onAskVerdict}
        idPrefix="tscript"
      />
    </FieldGroup>
  )
}

// ── action.terminal.readRecent ──────────────────────────────────────────────
export function TerminalReadRecentConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalReadRecent")
  const tabId = readString(params, "tabId")
  const lineLimit = readNumber(params, "lineLimit", 10)
  return (
    <FieldGroup>
      <Field
        label={t("tabId.label")}
        htmlFor="tread-tab"
        hint={t("tabId.hint")}
        name="tabId"
        required
      >
        <Input
          id="tread-tab"
          value={tabId}
          onChange={(e) => onChange(patchParam(params, "tabId", e.target.value))}
          placeholder={t("tabId.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <Field
        label={t("lineLimit.label")}
        htmlFor="tread-limit"
        hint={t("lineLimit.hint")}
        name="lineLimit"
      >
        <Input
          id="tread-limit"
          type="number"
          min={1}
          max={50}
          value={lineLimit}
          onChange={(e) =>
            onChange(
              patchParam(
                params,
                "lineLimit",
                Math.max(1, Math.min(50, Number(e.target.value) || 10))
              )
            )
          }
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.terminal.waitForExit ─────────────────────────────────────────────
export function TerminalWaitForExitConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalWaitForExit")
  const tabId = readString(params, "tabId")
  const timeoutSec = readNumber(params, "timeoutSec", 60)
  const onFailure = readString(params, "onFailure", "throw")
  return (
    <FieldGroup>
      <Field
        label={t("tabId.label")}
        htmlFor="twait-tab"
        hint={t("tabId.hint")}
        name="tabId"
        required
      >
        <Input
          id="twait-tab"
          value={tabId}
          onChange={(e) => onChange(patchParam(params, "tabId", e.target.value))}
          placeholder={t("tabId.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
      <FieldRow className="gap-2">
        <Field
          label={t("timeoutSec.label")}
          htmlFor="twait-timeout"
          hint={t("timeoutSec.hint")}
          name="timeoutSec"
        >
          <Input
            id="twait-timeout"
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(e) =>
              onChange(
                patchParam(
                  params,
                  "timeoutSec",
                  Math.max(5, Math.min(600, Number(e.target.value) || 60))
                )
              )
            }
          />
        </Field>
        <Field
          label={t("onFailure.label")}
          htmlFor="twait-onfail"
          hint={t("onFailure.hint")}
          name="onFailure"
        >
          <Select
            value={onFailure}
            onValueChange={(v) => onChange(patchParam(params, "onFailure", v))}
          >
            <SelectTrigger id="twait-onfail">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="throw">{t("onFailure.options.throw")}</SelectItem>
              <SelectItem value="branch">{t("onFailure.options.branch")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>
    </FieldGroup>
  )
}

// ── trigger.terminal.command ────────────────────────────────────────────────
export function TerminalCommandTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.terminalCommandTrigger")
  const sessionId = readString(params, "sessionId")
  const projectId = readString(params, "projectId")
  const status = readString(params, "status", "any")
  const commandContains = readString(params, "commandContains")
  return (
    <FieldGroup>
      <FieldRow className="gap-2">
        <Field
          label={t("sessionId.label")}
          htmlFor="ttrig-session"
          hint={t("sessionId.hint")}
          name="sessionId"
        >
          <Input
            id="ttrig-session"
            value={sessionId}
            onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
            placeholder={t("sessionId.placeholder")}
            className="font-mono text-xs"
          />
        </Field>
        <Field
          label={t("projectId.label")}
          htmlFor="ttrig-project"
          hint={t("projectId.hint")}
          name="projectId"
        >
          <Input
            id="ttrig-project"
            value={projectId}
            onChange={(e) => onChange(patchParam(params, "projectId", e.target.value))}
            placeholder={t("projectId.placeholder")}
          />
        </Field>
      </FieldRow>
      <Field label={t("status.label")} htmlFor="ttrig-status" hint={t("status.hint")} name="status">
        <Select
          value={status === "" ? "any" : status}
          onValueChange={(v) => onChange(patchParam(params, "status", v === "any" ? "" : v))}
        >
          <SelectTrigger id="ttrig-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("status.options.any")}</SelectItem>
            <SelectItem value="success">{t("status.options.success")}</SelectItem>
            <SelectItem value="failure">{t("status.options.failure")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("commandContains.label")}
        htmlFor="ttrig-contains"
        hint={t("commandContains.hint")}
        name="commandContains"
      >
        <Input
          id="ttrig-contains"
          value={commandContains}
          onChange={(e) => onChange(patchParam(params, "commandContains", e.target.value))}
          placeholder={t("commandContains.placeholder")}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}
