// ADR-0028 — Settings → Sandbox resource + network ceiling editor.
//
// Edits `AppSettings.sandboxPolicy`: the maximum CPU / memory / network reach
// a sandboxed shell may request. `cognia-sandboxed-tools` clamps every model
// tool call DOWN to this ceiling (via `lib/sandbox/policy-bridge`), so the
// model can ask for less but never more. A per-character override (set in the
// character editor) beats this app-level default.

"use client"

import { useId, useState } from "react"
import { useTranslations } from "next-intl"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import type { SandboxResourcePolicy } from "@cognia/agent-config-types"
import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"

const NETWORK_VALUES = ["off", "allowlist", "on"] as const
type NetworkCeiling = (typeof NETWORK_VALUES)[number]

function isNetwork(value: string): value is NetworkCeiling {
  return (NETWORK_VALUES as readonly string[]).includes(value)
}

/** Split a textarea blob into a clean host list (newline- or comma-separated). */
export function parseHostList(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const FORBIDDEN_WRITABLE_ROOTS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/run",
  "/var/run",
  "c:/windows",
  "c:/program files",
  "c:/program files (x86)",
  "c:/programdata",
]

const FORBIDDEN_COGNIA_APP_DATA_SUFFIXES = [
  "/.local/share/cognia",
  "/.config/cognia",
  "/library/application support/cognia",
  "/appdata/roaming/cognia",
  "/appdata/local/cognia",
]

function normalizeWritableRoot(path: string): string {
  let out = path.trim().replace(/\\/g, "/")
  if (/^[a-zA-Z]:\/+$/u.test(out)) return `${out.slice(0, 2).toLocaleLowerCase("en-US")}/`
  out = out.replace(/\/+$/u, "")
  return out.toLocaleLowerCase("en-US")
}

function isFilesystemRoot(path: string): boolean {
  const normalized = path.trim().replace(/\\/g, "/")
  return normalized === "/" || normalized === "\\" || /^[a-zA-Z]:\/?$/u.test(normalized)
}

function isUnderForbiddenRoot(path: string, forbiddenRoot: string): boolean {
  const normalized = normalizeWritableRoot(path)
  const forbidden = normalizeWritableRoot(forbiddenRoot)
  return normalized === forbidden || normalized.startsWith(`${forbidden}/`)
}

function isCogniaAppDataRoot(path: string): boolean {
  const normalized = normalizeWritableRoot(path)
  return FORBIDDEN_COGNIA_APP_DATA_SUFFIXES.some(
    (suffix) => normalized.endsWith(suffix) || normalized.includes(`${suffix}/`)
  )
}

export function findForbiddenWritableRoot(paths: string[]): string | null {
  for (const path of paths) {
    if (isFilesystemRoot(path)) return path
    if (isCogniaAppDataRoot(path)) return path
    if (FORBIDDEN_WRITABLE_ROOTS.some((root) => isUnderForbiddenRoot(path, root))) {
      return path
    }
  }
  return null
}

export interface SandboxPolicyFieldsProps {
  policy: SandboxResourcePolicy
  onChange: (policy: SandboxResourcePolicy) => void
  testIdPrefix?: string
}

/** Shared controlled editor used by app-, team-, and teammate-level policy owners. */
export function SandboxPolicyFields({
  policy,
  onChange,
  testIdPrefix = "sandbox-policy",
}: SandboxPolicyFieldsProps) {
  const t = useTranslations("settings.sandbox.policy")
  const cpuId = useId()
  const memId = useId()
  const netId = useId()
  const hostsId = useId()
  const rootsId = useId()
  const rootsErrorId = useId()
  const [writableRootsError, setWritableRootsError] = useState<string | null>(null)

  const update = (patch: Partial<SandboxResourcePolicy>) => {
    onChange({ ...policy, ...patch })
  }

  const network: NetworkCeiling = isNetwork(policy.network ?? "")
    ? (policy.network as NetworkCeiling)
    : "on"

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={cpuId}>{t("maxCpu.label")}</Label>
          <Input
            id={cpuId}
            type="number"
            min={0}
            inputMode="numeric"
            value={policy.maxCpuSeconds ?? 0}
            onChange={(e) =>
              update({ maxCpuSeconds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
            }
            data-testid={`${testIdPrefix}-cpu`}
          />
          <p className="text-xs text-muted-foreground">{t("maxCpu.description")}</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={memId}>{t("maxMemory.label")}</Label>
          <Input
            id={memId}
            type="number"
            min={0}
            inputMode="numeric"
            value={policy.maxMemoryMb ?? 0}
            onChange={(e) =>
              update({ maxMemoryMb: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
            }
            data-testid={`${testIdPrefix}-memory`}
          />
          <p className="text-xs text-muted-foreground">{t("maxMemory.description")}</p>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={netId}>{t("network.label")}</Label>
        <Select
          value={network}
          onValueChange={(value) => {
            if (isNetwork(value)) update({ network: value })
          }}
        >
          <SelectTrigger id={netId} data-testid={`${testIdPrefix}-network`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NETWORK_VALUES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`network.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t("network.description")}</p>
      </div>
      {network === "allowlist" && (
        <div className="grid gap-1.5">
          <Label htmlFor={hostsId}>{t("allowlist.label")}</Label>
          <Textarea
            id={hostsId}
            rows={3}
            defaultValue={(policy.networkAllowlist ?? []).join("\n")}
            placeholder={t("allowlist.placeholder")}
            onBlur={(e) => update({ networkAllowlist: parseHostList(e.target.value) })}
            data-testid={`${testIdPrefix}-allowlist`}
          />
          <p className="text-xs text-muted-foreground">{t("allowlist.description")}</p>
        </div>
      )}
      <div className="grid gap-1.5">
        <Label htmlFor={rootsId}>{t("writableRoots.label")}</Label>
        <Textarea
          id={rootsId}
          rows={3}
          defaultValue={(policy.writableRoots ?? []).join("\n")}
          placeholder={t("writableRoots.placeholder")}
          aria-invalid={writableRootsError ? true : undefined}
          aria-describedby={writableRootsError ? rootsErrorId : undefined}
          onBlur={(e) => {
            const writableRoots = parseHostList(e.target.value)
            const forbidden = findForbiddenWritableRoot(writableRoots)
            if (forbidden) {
              setWritableRootsError(t("writableRoots.errorForbidden", { path: forbidden }))
              return
            }
            setWritableRootsError(null)
            update({ writableRoots })
          }}
          data-testid={`${testIdPrefix}-writable-roots`}
        />
        {writableRootsError && (
          <p id={rootsErrorId} role="alert" className="text-xs text-destructive">
            {writableRootsError}
          </p>
        )}
        <p className="text-xs text-muted-foreground">{t("writableRoots.description")}</p>
      </div>
    </div>
  )
}

export function SandboxPolicyCard() {
  const t = useTranslations("settings.sandbox.policy")
  const settings = useSettingsStore((s) => s.settings)
  const policy: SandboxResourcePolicy = settings?.sandboxPolicy ?? {}

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <SandboxPolicyFields
          policy={policy}
          onChange={(next) => void saveSettings({ sandboxPolicy: next })}
        />
      </CardContent>
    </Card>
  )
}
