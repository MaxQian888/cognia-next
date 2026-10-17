"use client"

import { useId } from "react"
import { useTranslations } from "next-intl"
import {
  isValidExternalAgentSandboxHost,
  type ExternalAgentProcessSandboxPolicy,
} from "@cognia/agent-contracts/external-agent"

import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { detectOsFamily, type OsFamily } from "@/lib/platform/os"

interface ExternalAgentSandboxPolicyFieldProps {
  value?: ExternalAgentProcessSandboxPolicy
  onChange: (value: ExternalAgentProcessSandboxPolicy) => void
  /** The execution host OS; remote hosts with no OS report use unknown. */
  platform?: OsFamily
}

export function ExternalAgentSandboxPolicyField({
  value,
  onChange,
  platform = detectOsFamily(),
}: ExternalAgentSandboxPolicyFieldProps) {
  const t = useTranslations("externalAgentManage.editor")
  const id = useId()
  const network = value?.network ?? "full"
  const hosts = (value?.allowedHosts ?? []).map((host) => host.trim()).filter(Boolean)
  const invalidHosts = hosts.some((host) => !isValidExternalAgentSandboxHost(host))
  const invalid = network === "allowlist" && invalidHosts
  const inert = platform === "windows"

  return (
    <fieldset className="space-y-3" disabled={inert} aria-describedby={`${id}-hint`}>
      <legend className="text-sm font-medium">{t("sandboxPolicyTitle")}</legend>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        {t(inert ? "sandboxPolicyWindowsInert" : "sandboxPolicyHint")}
      </p>
      {!inert && <p className="text-xs text-muted-foreground">{t("sandboxPolicyWindowsNote")}</p>}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-network`}>{t("sandboxNetwork")}</Label>
        <NativeSelect
          id={`${id}-network`}
          value={network}
          onChange={(event) =>
            onChange({
              ...value,
              network: event.target.value as ExternalAgentProcessSandboxPolicy["network"],
            })
          }
        >
          <NativeSelectOption value="full">{t("sandboxNetworkFull")}</NativeSelectOption>
          <NativeSelectOption value="allowlist">{t("sandboxNetworkAllowlist")}</NativeSelectOption>
          <NativeSelectOption value="off">{t("sandboxNetworkOff")}</NativeSelectOption>
        </NativeSelect>
      </div>
      {network === "allowlist" && (
        <div className="grid gap-2">
          <Label htmlFor={`${id}-hosts`}>{t("sandboxAllowedHosts")}</Label>
          <Textarea
            id={`${id}-hosts`}
            value={value?.allowedHosts?.join("\n") ?? ""}
            onChange={(event) =>
              onChange({ ...value, allowedHosts: event.target.value.split("\n") })
            }
            placeholder={t("sandboxAllowedHostsPlaceholder")}
            aria-invalid={invalid}
            aria-describedby={`${id}-hosts-hint${invalid ? ` ${id}-error` : ""}`}
          />
          <p id={`${id}-hosts-hint`} className="text-xs text-muted-foreground">
            {t("sandboxAllowedHostsHint")}
          </p>
          {hosts.length === 0 && (
            <p className="text-xs text-muted-foreground">{t("sandboxAllowedHostsEmpty")}</p>
          )}
          {invalid && (
            <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
              {t("sandboxAllowedHostsInvalid")}
            </p>
          )}
        </div>
      )}
      <div className="grid gap-2">
        <Label htmlFor={`${id}-readable`}>{t("sandboxReadableScope")}</Label>
        <NativeSelect
          id={`${id}-readable`}
          value={value?.readableScope ?? "home"}
          onChange={(event) =>
            onChange({
              ...value,
              readableScope: event.target
                .value as ExternalAgentProcessSandboxPolicy["readableScope"],
            })
          }
        >
          <NativeSelectOption value="home">{t("sandboxReadableHome")}</NativeSelectOption>
          <NativeSelectOption value="workspace">{t("sandboxReadableWorkspace")}</NativeSelectOption>
        </NativeSelect>
        <p className="text-xs text-muted-foreground">{t("sandboxReadableHint")}</p>
      </div>
    </fieldset>
  )
}
