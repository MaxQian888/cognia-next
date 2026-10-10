"use client"

/**
 * The registries project images may come from on this desktop (ADR-0221 G10).
 *
 * The rows are edited locally and saved together: the allowlist is one field
 * of the settings document, and a half-typed row must not be written while
 * the next one is being filled in. A row the Rust side would refuse is named
 * here and blocks the save.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import type {
  RemoteSandboxesProblem,
  RemoteSandboxesWriteResult,
} from "@/hooks/sandbox/use-remote-sandboxes"
import { normalizeRegistryRules, validateRegistryRules } from "@/lib/sandbox/remote-sandbox-draft"
import type { RegistryRule } from "@/types/sandbox/remote-sandboxes"
import { RemoteSandboxesProblemText } from "./remote-sandboxes-problem-text"

export interface RemoteSandboxRegistryAllowlistProps {
  rules: readonly RegistryRule[]
  busy: boolean
  save(rules: RegistryRule[]): Promise<RemoteSandboxesWriteResult>
}

export function RemoteSandboxRegistryAllowlist({
  rules,
  busy,
  save,
}: RemoteSandboxRegistryAllowlistProps) {
  const t = useTranslations("settings.remoteSandboxes.registries")
  // The saved rules seed the rows once. After a save the rows stay as typed
  // and the Host's normalized copy comes back as `rules`, so "changed" is
  // asked of the normalized rows.
  const [rows, setRows] = useState<RegistryRule[]>(() => rules.map((rule) => ({ ...rule })))
  const [saveProblem, setSaveProblem] = useState<RemoteSandboxesProblem>()
  const [saved, setSaved] = useState(false)

  const problems = validateRegistryRules(rows)
  const dirty = JSON.stringify(normalizeRegistryRules(rows)) !== JSON.stringify(rules)

  const change = (index: number, patch: Partial<RegistryRule>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
    setSaved(false)
    setSaveProblem(undefined)
  }

  const onSave = async () => {
    const result = await save(rows)
    if (result.ok) setSaved(true)
    else setSaveProblem(result.problem)
  }

  return (
    <section className="space-y-3" data-testid="remote-sandbox-registries">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {rows.length === 0 ? <p className="text-xs text-muted-foreground">{t("empty")}</p> : null}

      <ul className="space-y-2">
        {rows.map((row, index) => {
          const problem = problems.get(index)
          return (
            <li key={index} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label={t("registry")}
                  placeholder={t("registryPlaceholder")}
                  className="min-w-0 flex-1 basis-40"
                  spellCheck={false}
                  value={row.registry}
                  onChange={(event) => change(index, { registry: event.target.value })}
                />
                <Input
                  aria-label={t("prefix")}
                  placeholder={t("prefixPlaceholder")}
                  className="min-w-0 flex-1 basis-40"
                  spellCheck={false}
                  value={row.repositoryPrefix}
                  onChange={(event) => change(index, { repositoryPrefix: event.target.value })}
                />
                <label className="flex items-center gap-1.5 text-xs">
                  <Checkbox
                    checked={row.insecure === true}
                    onCheckedChange={(checked) =>
                      change(index, { insecure: checked === true || undefined })
                    }
                  />
                  {t("insecure")}
                </label>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("removeRow", { registry: row.registry || String(index + 1) })}
                  onClick={() => {
                    setRows((prev) => prev.filter((_, i) => i !== index))
                    setSaved(false)
                  }}
                >
                  <Trash2Icon className="size-4" aria-hidden="true" />
                </Button>
              </div>
              {problem ? (
                <p role="alert" className="text-xs text-destructive">
                  {t(`problem.${problem}`)}
                </p>
              ) : null}
            </li>
          )
        })}
      </ul>

      {saveProblem ? <RemoteSandboxesProblemText problem={saveProblem} /> : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setRows((prev) => [...prev, { registry: "", repositoryPrefix: "" }])
            setSaved(false)
          }}
        >
          <PlusIcon className="size-4" aria-hidden="true" />
          {t("add")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy || !dirty || problems.size > 0}
          onClick={() => void onSave()}
        >
          {t("save")}
        </Button>
        {saved ? (
          <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
            {t("saved")}
          </p>
        ) : null}
      </div>
    </section>
  )
}
