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
  return (
    <Field
      label="Repository"
      htmlFor="gh-repo"
      hint="Format: owner/name. Supports {{ }} expressions."
      name="repoFullName"
      required
    >
      <ExpressionField
        id="gh-repo"
        value={readString(params, "repoFullName")}
        onChange={(v) => onChange(patchParam(params, "repoFullName", v))}
        placeholder="octocat/hello-world"
      />
    </Field>
  )
}

// ── trigger.github.webhook ───────────────────────────────────────────────

export function GithubWebhookTriggerConfig({ params, onChange }: ConfigProps) {
  const events = readStringList(params, "events")
  const toggle = (evt: string) => {
    const next = events.includes(evt) ? events.filter((e) => e !== evt) : [...events, evt]
    onChange(patchParam(params, "events", next))
  }
  return (
    <FieldGroup>
      <Field
        label="Events to listen for"
        hint="Pick one or more. The Rust receiver verifies the x-hub-signature-256 header."
        name="events"
        required
      >
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
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="Head branch" name="head" required hint="The branch with your changes.">
        <ExpressionField
          value={readString(params, "head")}
          onChange={(v) => onChange(patchParam(params, "head", v))}
          placeholder="feat/x"
        />
      </Field>
      <Field label="Base branch" name="base" required hint="The branch to merge into.">
        <ExpressionField
          value={readString(params, "base", "main")}
          onChange={(v) => onChange(patchParam(params, "base", v))}
          placeholder="main"
        />
      </Field>
      <Field label="Title" name="title" required>
        <ExpressionField
          value={readString(params, "title")}
          onChange={(v) => onChange(patchParam(params, "title", v))}
        />
      </Field>
      <Field label="Body" name="body" hint="Markdown supported.">
        <Textarea
          rows={4}
          value={readString(params, "body")}
          onChange={(e) => onChange(patchParam(params, "body", e.target.value))}
        />
      </Field>
      <Field label="Draft" name="draft" hint="Open as draft PR.">
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
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="PR number" name="prNumber" required>
        <Input
          type="number"
          value={readNumber(params, "prNumber", 0) || ""}
          onChange={(e) => onChange(patchParam(params, "prNumber", parseInt(e.target.value, 10) || 0))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.mergePr ────────────────────────────────────────────────

export function GithubMergePrConfig({ params, onChange }: ConfigProps) {
  const method = readString(params, "mergeMethod", "merge")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="PR number" name="prNumber" required>
        <Input
          type="number"
          value={readNumber(params, "prNumber", 0) || ""}
          onChange={(e) => onChange(patchParam(params, "prNumber", parseInt(e.target.value, 10) || 0))}
        />
      </Field>
      <Field label="Merge method" name="mergeMethod" required>
        <Select value={method} onValueChange={(v) => onChange(patchParam(params, "mergeMethod", v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="merge">Merge commit</SelectItem>
            <SelectItem value="squash">Squash and merge</SelectItem>
            <SelectItem value="rebase">Rebase and merge</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Commit title (optional)" name="commitTitle">
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
  const event = readString(params, "event", "COMMENT")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="PR number" name="prNumber" required>
        <Input
          type="number"
          value={readNumber(params, "prNumber", 0) || ""}
          onChange={(e) => onChange(patchParam(params, "prNumber", parseInt(e.target.value, 10) || 0))}
        />
      </Field>
      <Field label="Review verdict" name="event" required>
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
      <Field label="Review body" name="body" required hint="Supports {{ }} expressions.">
        <ExpressionField
          value={readString(params, "body")}
          onChange={(v) => onChange(patchParam(params, "body", v))}
          multiline
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.commentPr / commentIssue (shared) ─────────────────────

function buildCommentConfig(target: "pr" | "issue") {
  const Component = ({ params, onChange }: ConfigProps) => {
    const numField = target === "pr" ? "prNumber" : "issueNumber"
    return (
      <FieldGroup>
        <RepoFullNameField params={params} onChange={onChange} />
        <Field label={target === "pr" ? "PR number" : "Issue number"} name={numField} required>
          <Input
            type="number"
            value={readNumber(params, numField, 0) || ""}
            onChange={(e) =>
              onChange(patchParam(params, numField, parseInt(e.target.value, 10) || 0))
            }
          />
        </Field>
        <Field label="Comment body" name="body" required hint="Supports {{ }} expressions.">
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
        <Plus className="h-4 w-4 mr-1" /> Add label
      </Button>
    </div>
  )
}

export function GithubLabelIssueConfig({ params, onChange }: ConfigProps) {
  const add = readStringList(params, "add")
  const remove = readStringList(params, "remove")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="Issue/PR number" name="issueNumber" required>
        <Input
          type="number"
          value={readNumber(params, "issueNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "issueNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label="Labels to add" name="add">
        <LabelListEditor
          list={add}
          onChange={(next) => onChange(patchParam(params, "add", next))}
          placeholder="cognia:claim"
        />
      </Field>
      <Field label="Labels to remove" name="remove">
        <LabelListEditor
          list={remove}
          onChange={(next) => onChange(patchParam(params, "remove", next))}
          placeholder="wontfix"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.github.closeIssue ────────────────────────────────────────────

export function GithubCloseIssueConfig({ params, onChange }: ConfigProps) {
  const reason = readString(params, "reason", "")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="Issue number" name="issueNumber" required>
        <Input
          type="number"
          value={readNumber(params, "issueNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "issueNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label="Close reason" name="reason">
        <Select value={reason || "completed"} onValueChange={(v) => onChange(patchParam(params, "reason", v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="completed">Completed</SelectItem>
            <SelectItem value="not_planned">Not planned</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

// ── action.github.createRelease ─────────────────────────────────────────

export function GithubCreateReleaseConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="Tag" name="tag" required>
        <ExpressionField
          value={readString(params, "tag")}
          onChange={(v) => onChange(patchParam(params, "tag", v))}
          placeholder="v1.0.0"
        />
      </Field>
      <Field label="Release name" name="name">
        <ExpressionField
          value={readString(params, "name")}
          onChange={(v) => onChange(patchParam(params, "name", v))}
        />
      </Field>
      <Field label="Body" name="body" hint="Supports {{ }} expressions and Markdown.">
        <ExpressionField
          value={readString(params, "body")}
          onChange={(v) => onChange(patchParam(params, "body", v))}
          multiline
        />
      </Field>
      <Field label="Draft" name="draft">
        <Switch
          checked={readBoolean(params, "draft", true)}
          onCheckedChange={(b) => onChange(patchParam(params, "draft", b))}
        />
      </Field>
      <Field label="Prerelease" name="prerelease">
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
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="Since (tag or SHA)" name="since" required>
        <ExpressionField
          value={readString(params, "since")}
          onChange={(v) => onChange(patchParam(params, "since", v))}
          placeholder="v1.0.0"
        />
      </Field>
      <Field
        label="Current version"
        name="currentVersion"
        hint="Starting version for the bump calc. Defaults to 0.0.0."
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
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="Tag name" name="tag" required>
        <ExpressionField
          value={readString(params, "tag")}
          onChange={(v) => onChange(patchParam(params, "tag", v))}
          placeholder="v1.0.0"
        />
      </Field>
      <Field label="Commit SHA" name="sha" required hint="Full 40-char SHA recommended.">
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
  const mode = readString(params, "worktreeMode", "local")
  return (
    <FieldGroup>
      <RepoFullNameField params={params} onChange={onChange} />
      <Field label="Issue number" name="issueNumber" required>
        <Input
          type="number"
          value={readNumber(params, "issueNumber", 0) || ""}
          onChange={(e) =>
            onChange(patchParam(params, "issueNumber", parseInt(e.target.value, 10) || 0))
          }
        />
      </Field>
      <Field label="Worktree backend" name="worktreeMode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "worktreeMode", v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="local">Local git worktree</SelectItem>
            <SelectItem value="e2b">E2B sandbox (requires e2b-sandbox plugin)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Branch template"
        name="branchTemplate"
        hint="`{n}` is replaced by the issue number."
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
