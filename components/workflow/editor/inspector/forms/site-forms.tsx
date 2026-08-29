"use client"

/**
 * Per-kind inspector config forms for the Cognia Sites workflow nodes
 * (`action.site.{build,deploy,rollback,status}`, ADR-0084).
 *
 * Same pattern as `./git-ocr-forms.tsx`: `params` + `onChange`, the shared
 * `Field`/`FieldGroup`/`patchParam` helpers, and `ExpressionField` wherever a
 * value can be a `{{ }}` expression — which every one of these can, because the
 * usual flow is "build → deploy the version that produced".
 *
 * Param shapes match `lib/workflow/nodes/params-schemas.ts` and the executors
 * in `lib/workflow/nodes/sites/index.ts`.
 */

import { useTranslations } from "next-intl"

import { Field, FieldGroup, patchParam, readString } from "./shared"
import { ExpressionField } from "./shared/expression-field"

type Params = Record<string, unknown>
type ChangeFn = (next: Params) => void
interface ConfigProps {
  params: Params
  onChange: ChangeFn
}

/** Every Sites node addresses one Site, so the field is shared. */
function SiteIdField({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.site")
  return (
    <Field label={t("siteId.label")} name="siteId" required hint={t("siteId.hint")}>
      <ExpressionField
        value={readString(params, "siteId")}
        onChange={(value) => onChange(patchParam(params, "siteId", value))}
        placeholder={t("siteId.placeholder")}
      />
    </Field>
  )
}

/** Comma-separated hosts, matching the console's own network-allowance fields. */
function HostsField({
  params,
  onChange,
  name,
  label,
  hint,
}: ConfigProps & { name: string; label: string; hint: string }) {
  return (
    <Field label={label} name={name} hint={hint}>
      <ExpressionField
        value={(() => {
          const value = params[name]
          return Array.isArray(value) ? value.join(", ") : readString(params, name)
        })()}
        onChange={(value) =>
          onChange(
            patchParam(
              params,
              name,
              value
                .split(/[\n,]/)
                .map((entry) => entry.trim())
                .filter(Boolean)
            )
          )
        }
        // i18n-exempt: a hostname, not prose
        placeholder="registry.npmjs.org"
      />
    </Field>
  )
}

export function SiteBuildConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.site")
  return (
    <FieldGroup>
      <SiteIdField params={params} onChange={onChange} />
      <Field label={t("runtime.label")} name="runtime" hint={t("runtime.hint")}>
        <ExpressionField
          value={readString(params, "runtime")}
          onChange={(value) => onChange(patchParam(params, "runtime", value))}
          // i18n-exempt: a runtime identifier, not prose
          placeholder="node@24"
        />
      </Field>
      <Field
        label={t("packageManager.label")}
        name="packageManager"
        hint={t("packageManager.hint")}
      >
        <ExpressionField
          value={readString(params, "packageManager")}
          onChange={(value) => onChange(patchParam(params, "packageManager", value))}
          // i18n-exempt: a package-manager identifier, not prose
          placeholder="pnpm@10"
        />
      </Field>
      <HostsField
        params={params}
        onChange={onChange}
        name="installNetworkHosts"
        label={t("installNetworkHosts.label")}
        hint={t("installNetworkHosts.hint")}
      />
      <HostsField
        params={params}
        onChange={onChange}
        name="buildNetworkHosts"
        label={t("buildNetworkHosts.label")}
        hint={t("buildNetworkHosts.hint")}
      />
    </FieldGroup>
  )
}

export function SiteDeployConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.site")
  return (
    <FieldGroup>
      <SiteIdField params={params} onChange={onChange} />
      <Field label={t("versionId.label")} name="versionId" hint={t("versionId.hint")}>
        <ExpressionField
          value={readString(params, "versionId")}
          onChange={(value) => onChange(patchParam(params, "versionId", value))}
          // i18n-exempt: an expression example, not prose
          placeholder="{{ $node['build'].id }}"
        />
      </Field>
    </FieldGroup>
  )
}

export function SiteRollbackConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <SiteIdField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function SiteStatusConfig({ params, onChange }: ConfigProps) {
  return (
    <FieldGroup>
      <SiteIdField params={params} onChange={onChange} />
    </FieldGroup>
  )
}
