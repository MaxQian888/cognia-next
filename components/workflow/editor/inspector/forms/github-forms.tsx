"use client"

/**
 * Per-kind inspector config forms for the `action.github.*` workflow nodes
 * and the `trigger.github.webhook` trigger.
 *
 * Pattern mirrors the built-in forms in `./index.tsx` — every form takes
 * `params` + `onChange` and uses the shared `Field`/`FieldGroup`/`patchParam`
 * helpers. String fields that accept `{{ }}` expressions use the
 * `ExpressionField` component for syntax + autocomplete.
 */

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"
import { Field, FieldGroup, patchParam, readBoolean, readNumber, readString } from "./shared"
import { ExpressionField } from "./shared/expression-field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type Params = Record<string, unknown>
type ChangeFn = (next: Params) => void

interface ConfigProps {
  params: Params
  onChange: ChangeFn
}

const SUPPORTED_GH_EVENTS = [
  "pull_request.opened",
  "pull_request.synchronize",
  "pull_request.closed",
  "pull_request.review_requested",
  "issues.opened",
  "issues.closed",
  "issues.assigned",
  "issues.labeled",
  "issue_comment.created",
  "check_run.completed",
  "release.published",
] as const

function readStringList(params: Params, key: string): string[] {
  const v = params[key]
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === "string")
}

// ── Reusable: repo full-name input ───────────────────────────────────────

function RepoFullNameField({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.github.repoFullName")
  return (
    <Field label={t("label")} htmlFor="gh-repo" hint={t("hint")} name="repoFullName" required>
      <ExpressionField
        id="gh-repo"
        value={readString(params, "repoFullName")}
        onChange={(v) => onChange(patchParam(params, "repoFullName", v))}
        placeholder={t("placeholder")}
      />
    </Field>
  )
}

// ── trigger.github.webhook ───────────────────────────────────────────────

export function GithubWebhookTriggerConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.github.webhookTrigger")
  const events = readStringList(params, "events")
  const toggle = (evt: string) => {
    const next = events.includes(evt) ? events.filter((e) => e !== evt) : [...events, evt]
    onChange(patchParam(params, "events", next))
  }
  return (
    <FieldGroup>
      <Field label={t("events.label")} hint={t("events.hint")} name="events" required>
        <div className="grid grid-cols-1 gap-1.5">
          {SUPPORTED_GH_EVENTS.map((evt) => (
            <label key={evt} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={events.includes(evt)}
                onChange={() => toggle(evt)}
                className="h-4 w-4"
              />
              <span className="font-mono text-xs">{evt}</span>
            </label>
          ))}
        </div>
      </Field>
    </FieldGroup>
  )
}

// ── action.github.openPr ─────────────────────────────────────────────────

export function GithubOpenPrConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.github.openPr")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={t("head.label")} name="head" required hint={t("head.hint")}>
        <ExpressionField
          value={readString(params, "head")}
          onChange={(v) => onChange(patchParam(params, "head", v))}
          placeholder={t("head.placeholder")}
        />
      </Field>
      <Field label={t("base.label")} name="base" required hint={t("base.hint")}>
        <ExpressionField
          value={readString(params, "base", "main")}
          onChange={(v) => onChange(patchParam(params, "base", v))}
          placeholder={t("base.placeholder")}
        />
      </Field>
      <Field label={t("title.label")} name="title" required>
        <ExpressionField
          value={readString(params, "title")}
          onChange={(v) => onChange(patchParam(params, "title", v))}
        />
      </Field>
      <Field label={t("body.label")} name="body" hint={t("body.hint")}>
        <Textarea
          rows={4}
          value={readString(params, "body")}
          onChange={(e) => onChange(patchParam(params, "body", e.target.value))}
        />
      </Field>
      <Field label={t("draft.label")} name="draft" hint={t("draft.hint")}>
        <Switch
          checked={readBoolean(params, "draft", false)}
          onCheckedChange={(b) => onChange(patchParam(params, "draft", b))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.closePr ────────────────────────────────────────────────

export function GithubClosePrConfig({ params, onChange }: ConfigProps) {
  const tShared = useTranslations("workflows.forms.github")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={tShared("prNumber.label")} name="prNumber" required>
        <Input
          type="number"
          value={readNumber(params, "prNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "prNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.mergePr ────────────────────────────────────────────────

export function GithubMergePrConfig({ params, onChange }: ConfigProps) {
  const tShared = useTranslations("workflows.forms.github")
  const t = useTranslations("workflows.forms.github.mergePr")
  const method = readString(params, "mergeMethod", "merge")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={tShared("prNumber.label")} name="prNumber" required>
        <Input
          type="number"
          value={readNumber(params, "prNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "prNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label={t("mergeMethod.label")} name="mergeMethod" required>
        <Select
          value={method}
          onValueChange={(v) => onChange(patchParam(params, "mergeMethod", v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge">{t("mergeMethod.options.merge")}</SelectItem>
            <SelectItem value="squash">{t("mergeMethod.options.squash")}</SelectItem>
            <SelectItem value="rebase">{t("mergeMethod.options.rebase")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("commitTitle.label")} name="commitTitle">
        <ExpressionField
          value={readString(params, "commitTitle")}
          onChange={(v) => onChange(patchParam(params, "commitTitle", v))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.reviewPr ──────────────────────────────────────────────

export function GithubReviewPrConfig({ params, onChange }: ConfigProps) {
  const tShared = useTranslations("workflows.forms.github")
  const t = useTranslations("workflows.forms.github.reviewPr")
  const event = readString(params, "event", "COMMENT")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={tShared("prNumber.label")} name="prNumber" required>
        <Input
          type="number"
          value={readNumber(params, "prNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "prNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label={t("event.label")} name="event" required>
        <Select value={event} onValueChange={(v) => onChange(patchParam(params, "event", v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="APPROVE">APPROVE</SelectItem>
            <SelectItem value="REQUEST_CHANGES">REQUEST_CHANGES</SelectItem>
            <SelectItem value="COMMENT">COMMENT</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("body.label")} name="body" required hint={t("body.hint")}>
        <ExpressionField
          value={readString(params, "body")}
          onChange={(v) => onChange(patchParam(params, "body", v))}
          multiline
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.reviewPrInline (LLM-driven inline review) ─────────────

export function GithubReviewPrInlineConfig({ params, onChange }: ConfigProps) {
  const tShared = useTranslations("workflows.forms.github")
  const t = useTranslations("workflows.forms.github.reviewPrInline")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={tShared("prNumber.label")} name="prNumber" required>
        <Input
          type="number"
          value={readNumber(params, "prNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "prNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label={t("provider.label")} name="provider" required hint={t("provider.hint")}>
        <Input
          value={readString(params, "provider")}
          onChange={(e) => onChange(patchParam(params, "provider", e.target.value))}
          placeholder={t("provider.placeholder")}
        />
      </Field>
      <Field label={t("model.label")} name="model" required>
        <Input
          value={readString(params, "model")}
          onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
          placeholder={t("model.placeholder")}
        />
      </Field>
      <Field label={t("apiKey.label")} name="apiKey" required hint={t("apiKey.hint")}>
        <Input
          type="password"
          value={readString(params, "apiKey")}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <Field label={t("baseURL.label")} name="baseURL" hint={t("baseURL.hint")}>
        <Input
          value={readString(params, "baseURL")}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
          placeholder={t("baseURL.placeholder")}
        />
      </Field>
      <Field label={t("maxFiles.label")} name="maxFiles" hint={t("maxFiles.hint")}>
        <Input
          type="number"
          min={1}
          max={30}
          value={readNumber(params, "maxFiles", 5) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "maxFiles", parseInt(e.target.value, 10) || 5))
          }
        />
      </Field>
      <Field label={t("focus.label")} name="focus" hint={t("focus.hint")}>
        <ExpressionField
          value={readString(params, "focus")}
          onChange={(v) => onChange(patchParam(params, "focus", v))}
          multiline
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.commentPr / commentIssue (shared) ─────────────────────

function buildCommentConfig(target: "pr" | "issue") {
  const Component = ({ params, onChange }: ConfigProps) => {
    const tShared = useTranslations("workflows.forms.github")
    const tComment = useTranslations("workflows.forms.github.comment")
    const numField = target === "pr" ? "prNumber" : "issueNumber"
    return (
      <FieldGroup>
        <RepoFullNameField params={params} onChange={onChange} />
        <Field
          label={target === "pr" ? tShared("prNumber.label") : tShared("issueNumber.label")}
          name={numField}
          required
        >
          <Input
            type="number"
            value={readNumber(params, numField, 0) || ""}
            onChange={(e) =>
              onChange(patchParam(params, numField, parseInt(e.target.value, 10) || 0))
            }
          />
        </Field>
        <Field label={tComment("body.label")} name="body" required hint={tComment("body.hint")}>
          <ExpressionField
            value={readString(params, "body")}
            onChange={(v) => onChange(patchParam(params, "body", v))}
            multiline
          />
        </Field>
      </FieldGroup>
    )
  }
  Component.displayName = target === "pr" ? "GithubCommentPrConfig" : "GithubCommentIssueConfig"
  return Component
}

export const GithubCommentPrConfig = buildCommentConfig("pr")
export const GithubCommentIssueConfig = buildCommentConfig("issue")

// ── action.github.labelIssue ────────────────────────────────────────────

function LabelListEditor({
  list,
  onChange,
  placeholder,
}: {
  list: string[]
  onChange: (next: string[]) => void
  placeholder: string
}) {
  const tShared = useTranslations("workflows.forms.github")
  return (
    <div className="space-y-1">
      {list.map((label, idx) => (
        <div key={idx} className="flex gap-1">
          <Input
            value={label}
            onChange={(e) => {
              const next = [...list]
              next[idx] = e.target.value
              onChange(next)
            }}
            placeholder={placeholder}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(list.filter((_, i) => i !== idx))}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...list, ""])}>
        <Plus className="h-4 w-4 mr-1" /> {tShared("addLabel")}
      </Button>
    </div>
  )
}

export function GithubLabelIssueConfig({ params, onChange }: ConfigProps) {
  const tShared = useTranslations("workflows.forms.github")
  const t = useTranslations("workflows.forms.github.labelIssue")
  const add = readStringList(params, "add")
  const remove = readStringList(params, "remove")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={tShared("issuePrNumber.label")} name="issueNumber" required>
        <Input
          type="number"
          value={readNumber(params, "issueNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "issueNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label={t("add.label")} name="add">
        <LabelListEditor
          list={add}
          onChange={(next) => onChange(patchParam(params, "add", next))}
          placeholder={t("add.placeholder")}
        />
      </Field>
      <Field label={t("remove.label")} name="remove">
        <LabelListEditor
          list={remove}
          onChange={(next) => onChange(patchParam(params, "remove", next))}
          placeholder={t("remove.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.closeIssue ────────────────────────────────────────────

export function GithubCloseIssueConfig({ params, onChange }: ConfigProps) {
  const tShared = useTranslations("workflows.forms.github")
  const t = useTranslations("workflows.forms.github.closeIssue")
  const reason = readString(params, "reason", "")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={tShared("issueNumber.label")} name="issueNumber" required>
        <Input
          type="number"
          value={readNumber(params, "issueNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "issueNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label={t("reason.label")} name="reason">
        <Select
          value={reason || "completed"}
          onValueChange={(v) => onChange(patchParam(params, "reason", v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="completed">{t("reason.options.completed")}</SelectItem>
            <SelectItem value="not_planned">{t("reason.options.not_planned")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

// ── action.github.createRelease ─────────────────────────────────────────

export function GithubCreateReleaseConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.github.createRelease")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={t("tag.label")} name="tag" required>
        <ExpressionField
          value={readString(params, "tag")}
          onChange={(v) => onChange(patchParam(params, "tag", v))}
          placeholder={t("tag.placeholder")}
        />
      </Field>
      <Field label={t("name.label")} name="name">
        <ExpressionField
          value={readString(params, "name")}
          onChange={(v) => onChange(patchParam(params, "name", v))}
        />
      </Field>
      <Field label={t("body.label")} name="body" hint={t("body.hint")}>
        <ExpressionField
          value={readString(params, "body")}
          onChange={(v) => onChange(patchParam(params, "body", v))}
          multiline
        />
      </Field>
      <Field label={t("draft.label")} name="draft">
        <Switch
          checked={readBoolean(params, "draft", true)}
          onCheckedChange={(b) => onChange(patchParam(params, "draft", b))}
        />
      </Field>
      <Field label={t("prerelease.label")} name="prerelease">
        <Switch
          checked={readBoolean(params, "prerelease", false)}
          onCheckedChange={(b) => onChange(patchParam(params, "prerelease", b))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.generateChangelog ─────────────────────────────────────

export function GithubGenerateChangelogConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.github.generateChangelog")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={t("since.label")} name="since" required>
        <ExpressionField
          value={readString(params, "since")}
          onChange={(v) => onChange(patchParam(params, "since", v))}
          placeholder={t("since.placeholder")}
        />
      </Field>
      <Field
        label={t("currentVersion.label")}
        name="currentVersion"
        hint={t("currentVersion.hint")}
      >
        <ExpressionField
          value={readString(params, "currentVersion", "0.0.0")}
          onChange={(v) => onChange(patchParam(params, "currentVersion", v))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.pushTag ───────────────────────────────────────────────

export function GithubPushTagConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.github.pushTag")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={t("tag.label")} name="tag" required>
        <ExpressionField
          value={readString(params, "tag")}
          onChange={(v) => onChange(patchParam(params, "tag", v))}
          placeholder={t("tag.placeholder")}
        />
      </Field>
      <Field label={t("sha.label")} name="sha" required hint={t("sha.hint")}>
        <ExpressionField
          value={readString(params, "sha")}
          onChange={(v) => onChange(patchParam(params, "sha", v))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.runIssueLoop ──────────────────────────────────────────

export function GithubRunIssueLoopConfig({ params, onChange }: ConfigProps) {
  const tShared = useTranslations("workflows.forms.github")
  const t = useTranslations("workflows.forms.github.runIssueLoop")
  const mode = readString(params, "worktreeMode", "local")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label={tShared("issueNumber.label")} name="issueNumber" required>
        <Input
          type="number"
          value={readNumber(params, "issueNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "issueNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label={t("worktreeMode.label")} name="worktreeMode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "worktreeMode", v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">{t("worktreeMode.options.local")}</SelectItem>
            <SelectItem value="e2b">{t("worktreeMode.options.e2b")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("branchTemplate.label")}
        name="branchTemplate"
        hint={t("branchTemplate.hint")}
      >
        <Input
          value={readString(params, "branchTemplate", "cognia/issue-{n}")}
          onChange={(e) => onChange(patchParam(params, "branchTemplate", e.target.value))}
          className="font-mono"
        />
      </Field>
    </FieldGroup>
  )
}
