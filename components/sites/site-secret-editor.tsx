"use client"

/**
 * Per-secret keep / replace / remove.
 *
 * `KvEditor` cannot express this. A secret's value is unreadable by design —
 * it lives in the host keyring — so an editor seeded from the stored revision
 * has keys and no values, and a plain key/value grid can only offer "type it
 * again or lose it". That is exactly what the old editor did: it opened with an
 * empty secrets grid, and `saveEnvironment` rebuilt the reference list from
 * whatever was in it, so changing one variable silently dropped every secret
 * from the new revision.
 *
 * Keeping is therefore the default, and every departure from it is a choice the
 * user made on that row.
 */
import { useTranslations } from "next-intl"
import { KeyRoundIcon, PlusIcon, RotateCcwIcon, TrashIcon, UndoIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { SiteSecretEdit } from "@/types/sites"

export interface SiteSecretEditorProps {
  /** Keys the current revision holds. Their values are never available. */
  storedKeys: readonly string[]
  edits: readonly SiteSecretEdit[]
  onChange: (edits: SiteSecretEdit[]) => void
  disabled?: boolean
}

export function SiteSecretEditor({ storedKeys, edits, onChange, disabled }: SiteSecretEditorProps) {
  const t = useTranslations("sites")

  const replace = (key: string, next: SiteSecretEdit | null) => {
    onChange(
      next
        ? edits.map((edit) => (edit.key === key ? next : edit))
        : edits.filter((edit) => edit.key !== key)
    )
  }

  return (
    <div className="space-y-2" data-testid="site-secret-editor">
      <div className="flex items-center gap-1.5">
        <KeyRoundIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("environment.secrets")}
        </h4>
        <span className="text-[10px] text-muted-foreground">
          {t("environment.secretValueHidden")}
        </span>
      </div>

      {edits.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("environment.noSecretRefs")}</p>
      ) : null}

      <ul className="space-y-1.5">
        {edits.map((edit) => {
          const stored = storedKeys.includes(edit.key)
          return (
            <li
              key={edit.key}
              className="flex flex-wrap items-center gap-2"
              data-testid={`site-secret-${edit.key}`}
            >
              <span
                className={cn(
                  "w-40 shrink-0 truncate font-mono text-xs",
                  edit.action === "remove" && "text-muted-foreground line-through"
                )}
              >
                {edit.key}
              </span>

              {edit.action === "set" ? (
                <Input
                  type="password"
                  className="h-8 min-w-0 flex-1"
                  value={edit.value}
                  disabled={disabled}
                  aria-label={t("environment.secretAction.set", { key: edit.key })}
                  placeholder={t("environment.secretsPlaceholder")}
                  onChange={(event) =>
                    replace(edit.key, { key: edit.key, action: "set", value: event.target.value })
                  }
                />
              ) : (
                <span className="min-w-0 flex-1 font-mono text-xs text-muted-foreground">
                  {edit.action === "keep"
                    ? t("environment.secretAction.keptHint")
                    : t("environment.secretAction.removedHint")}
                </span>
              )}

              <span className="flex shrink-0 items-center gap-1">
                {edit.action !== "set" ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => replace(edit.key, { key: edit.key, action: "set", value: "" })}
                    data-testid={`site-secret-replace-${edit.key}`}
                  >
                    <RotateCcwIcon aria-hidden className="size-3" />
                    {t("environment.secretAction.replace")}
                  </Button>
                ) : null}
                {edit.action !== "keep" && stored ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => replace(edit.key, { key: edit.key, action: "keep" })}
                    data-testid={`site-secret-keep-${edit.key}`}
                  >
                    <UndoIcon aria-hidden className="size-3" />
                    {t("environment.secretAction.keep")}
                  </Button>
                ) : null}
                {edit.action !== "remove" ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={t("environment.secretAction.remove")}
                    onClick={() =>
                      stored
                        ? replace(edit.key, { key: edit.key, action: "remove" })
                        : replace(edit.key, null)
                    }
                    data-testid={`site-secret-remove-${edit.key}`}
                  >
                    <TrashIcon aria-hidden className="size-3" />
                  </Button>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>

      <NewSecretRow
        disabled={disabled}
        taken={edits.map((edit) => edit.key)}
        onAdd={(key) => onChange([...edits, { key, action: "set", value: "" }])}
      />
    </div>
  )
}

function NewSecretRow({
  disabled,
  taken,
  onAdd,
}: {
  disabled?: boolean
  taken: readonly string[]
  onAdd: (key: string) => void
}) {
  const t = useTranslations("sites")
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        const field = event.currentTarget.elements.namedItem("key") as HTMLInputElement | null
        const key = field?.value.trim() ?? ""
        if (!key || taken.includes(key)) return
        onAdd(key)
        if (field) field.value = ""
      }}
    >
      <Input
        name="key"
        className="h-8 w-40"
        disabled={disabled}
        aria-label={t("environment.secretAction.newKey")}
        // i18n-exempt: an environment variable name, not prose
        placeholder="API_TOKEN"
      />
      <Button
        type="submit"
        size="xs"
        variant="outline"
        disabled={disabled}
        data-testid="site-secret-add"
      >
        <PlusIcon aria-hidden className="size-3" />
        {t("environment.secretAction.add")}
      </Button>
    </form>
  )
}
