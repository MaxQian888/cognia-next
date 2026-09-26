"use client"

/**
 * Agent-scoped `Character.sandboxPolicy` editor.
 *
 * `resolveSendOptions` reads `character.sandboxPolicy ??
 * appSettings.sandboxPolicy`, so the agent ceiling replaces the app one
 * wholesale while set. The fields are the shared {@link SandboxPolicyFields}
 * the app-, team- and teammate-level owners already use; this adds only the
 * inherit state. Taking the ceiling over starts from an empty policy, which
 * every backend reads as "its own default" per field.
 */

import { useTranslations } from "next-intl"

import type { SandboxResourcePolicy } from "@cognia/agent-config-types"
import { SandboxPolicyFields } from "@/components/settings/sandbox/sandbox-policy-card"
import { InheritSelect } from "./inherit-select"

export interface SandboxPolicyOverrideProps {
  value: SandboxResourcePolicy | undefined
  onChange: (next: SandboxResourcePolicy | undefined) => void
}

export function SandboxPolicyOverride({ value, onChange }: SandboxPolicyOverrideProps) {
  const t = useTranslations("settings.characters.editor.advanced.sandboxPolicy")
  return (
    <div className="space-y-2" data-testid="agent-override-sandbox-policy">
      <InheritSelect<"override">
        id="agent-override-sandbox-policy"
        label={t("label")}
        description={t("description")}
        value={value === undefined ? undefined : "override"}
        options={[{ value: "override", label: t("override") }]}
        onChange={(choice) => onChange(choice === undefined ? undefined : {})}
      />
      {value !== undefined && (
        <div className="rounded-md border bg-background p-2">
          <SandboxPolicyFields
            policy={value}
            onChange={onChange}
            testIdPrefix="agent-sandbox-policy"
          />
        </div>
      )}
    </div>
  )
}
