"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import type { MemoryCallerNamespaces } from "@cognia/memory/types/caller"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"

const dimensions = ["projects", "characterIds", "agentIds"] as const
const scopes = ["global", "workspace", "character", "agent"] as const
type Grants = Record<string, MemoryCallerNamespaces>

/** Separate editor because access grants have their own draft and save lifecycle. */
export function MemoryPrincipalAccess({
  grants = {},
  save,
}: {
  grants?: Grants
  save: (grants: Grants) => Promise<void>
}) {
  const t = useTranslations("settings.memory.access")
  const [principal, setPrincipal] = useState("")
  const [allowedScopes, setAllowedScopes] = useState<string[]>([...scopes])
  const [values, setValues] = useState({ projects: "*", characterIds: "*", agentIds: "*" })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const persist = async (next: Grants) => {
    setBusy(true)
    setError(undefined)
    try {
      await save(next)
      setPrincipal("")
    } catch {
      setError(t("saveFailed"))
    } finally {
      setBusy(false)
    }
  }
  const submit = () => {
    const id = principal.trim()
    if (
      !/^(local-user|cli:tui|mcp:bridge|plugin:.+|companion:.+|workflow(?::.+)?|job:.+|transport:(local-ui|cli|mcp|plugin|companion|workflow|internal-job))$/.test(
        id
      )
    ) {
      setError(t("invalidPrincipal"))
      return
    }
    const grant: MemoryCallerNamespaces = { scopes: allowedScopes }
    for (const dimension of dimensions) {
      const value = values[dimension].trim()
      if (value !== "*")
        grant[dimension] = [
          ...new Set(
            value
              .split(",")
              .map((v) => v.trim())
              .filter(Boolean)
          ),
        ]
    }
    void persist({ ...grants, [id]: grant })
  }
  return (
    <section className="space-y-3 rounded-lg border p-3" aria-labelledby="memory-access-title">
      <h4 id="memory-access-title" className="text-sm font-medium">
        {t("title")}
      </h4>
      <p className="text-xs text-muted-foreground">{t("description")}</p>
      {Object.entries(grants).map(([id, grant]) => (
        <div key={id} className="flex flex-wrap items-center gap-2">
          <code className="text-xs">{id}</code>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setPrincipal(id)
              setAllowedScopes([...(grant.scopes ?? scopes)])
              setValues({
                projects: grant.projects?.join(", ") ?? "*",
                characterIds: grant.characterIds?.join(", ") ?? "*",
                agentIds: grant.agentIds?.join(", ") ?? "*",
              })
            }}
          >
            {t("edit")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              void persist({ ...grants, [id]: { scopes: [] } })
            }}
          >
            {t("revoke")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              const next = { ...grants }
              delete next[id]
              void persist(next)
            }}
          >
            {t("inherit")}
          </Button>
          <span className="text-xs text-muted-foreground">
            {grant.scopes?.length === 0 ? t("denied") : t("restricted")}
          </span>
        </div>
      ))}
      <Label htmlFor="memory-principal">{t("principal")}</Label>
      <Input
        id="memory-principal"
        value={principal}
        disabled={busy}
        onChange={(e) => setPrincipal(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">{t("principalHelp")}</p>
      <fieldset className="flex flex-wrap gap-3" disabled={busy}>
        <legend className="mb-2 text-sm">{t("scopes")}</legend>
        {scopes.map((scope) => (
          <label key={scope} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={allowedScopes.includes(scope)}
              onCheckedChange={(checked) =>
                setAllowedScopes((old) =>
                  checked === true ? [...old, scope] : old.filter((s) => s !== scope)
                )
              }
            />
            {t(`scope.${scope}`)}
          </label>
        ))}
      </fieldset>
      {dimensions.map((dimension) => (
        <div key={dimension} className="space-y-1">
          <Label htmlFor={`memory-access-${dimension}`}>{t(dimension)}</Label>
          <Input
            id={`memory-access-${dimension}`}
            disabled={busy}
            value={values[dimension]}
            onChange={(e) => setValues((old) => ({ ...old, [dimension]: e.target.value }))}
          />
        </div>
      ))}
      <p className="text-xs text-muted-foreground">{t("namespaceHelp")}</p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button disabled={busy || !principal.trim()} onClick={submit}>
        {t("save")}
      </Button>
    </section>
  )
}
