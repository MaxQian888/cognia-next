"use client"

/**
 * Inspector config forms for the stacked-branch workflow nodes
 * (`action.stack.{list,parent,validate,restack,push}`).
 *
 * Same shape as `./git-ocr-forms.tsx` — `params` + `onChange`, the shared
 * `Field`/`FieldGroup`/`patchParam` helpers, `ExpressionField` for anything
 * that accepts `{{ }}`. Param names match `lib/workflow/nodes/params-schemas.ts`
 * and the executors in `lib/workflow/nodes/source-control/stack.ts`.
 *
 * Four of the five kinds address their layers the same way, so that pair of
 * fields is one component: name the branches, or name the tip of a chain and
 * let the recorded parent pointers supply the rest.
 */

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Field, FieldGroup, patchParam, readString } from "./shared"
import { ExpressionField } from "./shared/expression-field"

type Params = Record<string, unknown>

interface ConfigProps {
  params: Params
  onChange: (next: Params) => void
}

function readStringList(params: Params, key: string): string {
  const value = params[key]
  if (!Array.isArray(value)) return ""
  return value.filter((item): item is string => typeof item === "string").join(", ")
}

function parseStringList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

/** Repository addressing, shared by every stack node. */
function RepoFields({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.stack.repo")
  return (
    <>
      <Field label={t("path.label")} htmlFor="stack-repo" hint={t("path.hint")} name="repoPath">
        <ExpressionField
          id="stack-repo"
          value={readString(params, "repoPath")}
          onChange={(value) => onChange(patchParam(params, "repoPath", value))}
          placeholder={t("path.placeholder")}
        />
      </Field>
      <Field
        label={t("workspace.label")}
        htmlFor="stack-project"
        hint={t("workspace.hint")}
        name="projectId"
      >
        <ExpressionField
          id="stack-project"
          value={readString(params, "projectId")}
          onChange={(value) => onChange(patchParam(params, "projectId", value))}
          placeholder={t("workspace.placeholder")}
        />
      </Field>
    </>
  )
}

/** Which layers a node acts on: an explicit list, or the tip of a chain. */
function LayerFields({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.stack.layers")
  return (
    <>
      <Field label={t("tip.label")} htmlFor="stack-tip" hint={t("tip.hint")} name="tipBranch">
        <ExpressionField
          id="stack-tip"
          value={readString(params, "tipBranch")}
          onChange={(value) => onChange(patchParam(params, "tipBranch", value))}
          placeholder={t("tip.placeholder")}
        />
      </Field>
      <Field
        label={t("branches.label")}
        htmlFor="stack-branches"
        hint={t("branches.hint")}
        name="branches"
      >
        <Input
          id="stack-branches"
          value={readStringList(params, "branches")}
          onChange={(event) =>
            onChange(patchParam(params, "branches", parseStringList(event.target.value)))
          }
          placeholder={t("branches.placeholder")}
        />
      </Field>
    </>
  )
}

export function StackListConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <RepoFields params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function StackParentConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.stack.parent")
  return (
    <FieldGroup>
      <RepoFields params={params} onChange={onChange} />
      <Field label={t("branch.label")} name="branch" required hint={t("branch.hint")}>
        <ExpressionField
          value={readString(params, "branch")}
          onChange={(value) => onChange(patchParam(params, "branch", value))}
          placeholder={t("branch.placeholder")}
        />
      </Field>
      <Field label={t("parent.label")} name="parent" hint={t("parent.hint")}>
        <ExpressionField
          value={readString(params, "parent")}
          onChange={(value) => onChange(patchParam(params, "parent", value))}
          placeholder={t("parent.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

export function StackValidateConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <RepoFields params={params} onChange={onChange} />
      <LayerFields params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function StackRestackConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.stack.restack")
  return (
    <FieldGroup>
      <RepoFields params={params} onChange={onChange} />
      <LayerFields params={params} onChange={onChange} />
      <Field label={t("onto.label")} name="onto" hint={t("onto.hint")}>
        <ExpressionField
          value={readString(params, "onto")}
          onChange={(value) => onChange(patchParam(params, "onto", value))}
          placeholder={t("onto.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

export function StackPushConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.stack.push")
  return (
    <FieldGroup>
      <RepoFields params={params} onChange={onChange} />
      <LayerFields params={params} onChange={onChange} />
      <Field label={t("remote.label")} name="remote" hint={t("remote.hint")}>
        <ExpressionField
          value={readString(params, "remote")}
          onChange={(value) => onChange(patchParam(params, "remote", value))}
          placeholder={t("remote.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}
