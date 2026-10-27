"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { shellQuote, tokenizeShellCommand } from "@/lib/mcp/config-transfer"
import type { KvRow } from "@/components/settings/mcp/mcp-server-utils"

/** Shared create/edit controls backed by the native arguments and environment. */
export function GooseRuntimeFields({
  rows,
  onRowsChange,
  args,
  onArgsChange,
}: {
  rows: KvRow[]
  onRowsChange(rows: KvRow[]): void
  args: string
  onArgsChange(args: string): void
}) {
  const t = useTranslations("externalAgent.goose")
  const tokens = tokenizeShellCommand(args)
  const builtins: string[] = []
  const other: string[] = []
  for (let i = 0; i < (tokens?.length ?? 0); i++) {
    const token = tokens![i]
    if (token === "--with-builtin" && tokens![i + 1]) builtins.push(...tokens![++i].split(","))
    else if (token.startsWith("--with-builtin=")) builtins.push(...token.slice(15).split(","))
    else other.push(token)
  }
  const concurrency = rows.find((row) => row.key === "GOOSE_MAX_CONCURRENT_SUBAGENTS")?.value ?? ""
  return (
    <fieldset className="grid gap-3 rounded-md border p-3">
      <legend className="text-sm font-medium">{t("runtimeTitle")}</legend>
      <Label htmlFor="goose-concurrency">{t("concurrency")}</Label>
      <Input
        id="goose-concurrency"
        type="number"
        min={1}
        step={1}
        placeholder="5"
        value={concurrency}
        onChange={(event) => {
          const value = event.target.value
          if (value && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) return
          onRowsChange([
            ...rows.filter((row) => row.key !== "GOOSE_MAX_CONCURRENT_SUBAGENTS"),
            ...(value ? [{ key: "GOOSE_MAX_CONCURRENT_SUBAGENTS", value }] : []),
          ])
        }}
      />
      <p className="text-xs text-muted-foreground">{t("concurrencyHint")}</p>
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="goose-code-mode">{t("codeMode")}</Label>
        <Switch
          id="goose-code-mode"
          checked={builtins.includes("code_execution")}
          disabled={!tokens}
          onCheckedChange={(enabled) => {
            const names = [
              ...new Set([
                ...builtins.filter((name) => name !== "code_execution"),
                ...(enabled ? ["code_execution"] : []),
              ]),
            ]
            onArgsChange(
              [...other, ...(names.length ? ["--with-builtin", names.join(",")] : [])]
                .map(shellQuote)
                .join(" ")
            )
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{t("codeModeHint")}</p>
    </fieldset>
  )
}
