"use client"

/**
 * Who may do what to this Site.
 *
 * ADR-0084 separates authoring authorization from visitor access, and the
 * authoring half was fully built and completely unreachable:
 * `updateSiteAuthoringPolicy` had validation, normalization, and an owner-only
 * guard but no caller; `siteRoleCapabilities` had no caller; and four i18n keys
 * sat unused. Sixteen `assertSiteAuthoringCapability` call sites enforced a
 * policy nobody could change, so `editorAccountIds` and `deployerAccountIds`
 * were `[]` on every Site ever created and every gate resolved to "owner".
 *
 * This is that editor. It runs on `metadata` — pure Dexie, no host — so it
 * works in the browser shell too, unlike everything else that mutates a Site.
 */
import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlusIcon, ShieldCheckIcon, XIcon } from "lucide-react"

import { Surface } from "@/components/surface/surface"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { siteRoleCapabilities, siteViewerRole } from "@/lib/sites/console-model"
import { cn } from "@/lib/utils"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"
import type { SiteAuthoringPolicy, SiteProjectRow } from "@/types/sites"

type AccountList = "editorAccountIds" | "deployerAccountIds"

export interface SiteAccessTabProps {
  site: SiteProjectRow
  actorAccountId: string
  gate: SiteGate
  isBusy: (key?: string) => boolean
  onSave: (policy: SiteAuthoringPolicy) => void
}

export function SiteAccessTab({ site, actorAccountId, gate, isBusy, onSave }: SiteAccessTabProps) {
  const t = useTranslations("sites")
  const [draft, setDraft] = useState<SiteAuthoringPolicy | null>(null)
  const policy = draft ?? site.authoringPolicy
  const role = siteViewerRole(policy, actorAccountId)
  const capabilities = siteRoleCapabilities(role)
  const disabled = isBusy("authoring") || !gate.allowed

  const mutate = (list: AccountList, next: string[]) => setDraft({ ...policy, [list]: next })

  const dirty =
    draft !== null &&
    (draft.editorAccountIds.join() !== site.authoringPolicy.editorAccountIds.join() ||
      draft.deployerAccountIds.join() !== site.authoringPolicy.deployerAccountIds.join())

  return (
    <div className="space-y-4" data-testid="site-access-tab">
      <Surface layer="raised" radius="panel" className="border">
        <header className="border-b px-3 py-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <ShieldCheckIcon aria-hidden className="size-4 text-muted-foreground" />
            {t("authoring.title")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("authoring.description")}</p>
        </header>

        <div className="space-y-3 p-3">
          <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="site-your-role">
            <span className={cn(role === "viewer" && "text-warning")}>
              {t("authoring.yourRole", { role: t(`overview.role.${role}`) })}
            </span>
            {capabilities.length > 0 ? (
              <span className="text-muted-foreground">
                {t("authoring.capabilities", {
                  list: capabilities.map((capability) => t(`capability.${capability}`)).join(", "),
                })}
              </span>
            ) : (
              <span className="text-muted-foreground">{t("authoring.noCapabilities")}</span>
            )}
          </p>

          <div className="text-xs">
            <span className="text-muted-foreground">{t("authoring.owner")}: </span>
            <code className="font-mono">{policy.ownerAccountId}</code>
            {policy.ownerAccountId === actorAccountId ? (
              <Badge variant="outline" className="ml-1.5 h-4 px-1 text-[10px] font-normal">
                {t("authoring.you")}
              </Badge>
            ) : null}
          </div>

          <AccountListEditor
            label={t("authoring.editors")}
            addLabel={t("authoring.addEditor")}
            accounts={policy.editorAccountIds}
            ownerAccountId={policy.ownerAccountId}
            actorAccountId={actorAccountId}
            disabled={disabled}
            onChange={(next) => mutate("editorAccountIds", next)}
          />
          <AccountListEditor
            label={t("authoring.deployers")}
            addLabel={t("authoring.addDeployer")}
            accounts={policy.deployerAccountIds}
            ownerAccountId={policy.ownerAccountId}
            actorAccountId={actorAccountId}
            disabled={disabled}
            onChange={(next) => mutate("deployerAccountIds", next)}
          />

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled || !dirty}
              title={gate.title}
              onClick={() => {
                onSave(policy)
                setDraft(null)
              }}
              data-testid="site-save-authoring"
            >
              {t("actions.saveAuthoring")}
            </Button>
            {dirty ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={isBusy("authoring")}
                onClick={() => setDraft(null)}
              >
                {t("actions.cancelEdit")}
              </Button>
            ) : null}
          </div>
        </div>
      </Surface>
    </div>
  )
}

function AccountListEditor({
  label,
  addLabel,
  accounts,
  ownerAccountId,
  actorAccountId,
  disabled,
  onChange,
}: {
  label: string
  addLabel: string
  accounts: readonly string[]
  ownerAccountId: string
  actorAccountId: string
  disabled?: boolean
  onChange: (next: string[]) => void
}) {
  const t = useTranslations("sites")
  const [value, setValue] = useState("")

  const add = () => {
    const account = value.trim()
    // The owner already outranks both lists, so naming them again would render
    // a row that changes nothing — `updateSiteAuthoringPolicy` strips it anyway.
    if (!account || account === ownerAccountId || accounts.includes(account)) return
    onChange([...accounts, account])
    setValue("")
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </Label>
      {accounts.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("authoring.empty")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {accounts.map((account) => (
            <li key={account}>
              <Badge variant="outline" className="gap-1 font-mono font-normal">
                {account}
                {account === actorAccountId ? (
                  <span className="text-muted-foreground">({t("authoring.you")})</span>
                ) : null}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="-mr-1 size-4"
                  disabled={disabled}
                  aria-label={t("authoring.remove", { account })}
                  onClick={() => onChange(accounts.filter((entry) => entry !== account))}
                >
                  <XIcon aria-hidden className="size-3" />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Input
          className="h-8 max-w-xs"
          value={value}
          disabled={disabled}
          aria-label={addLabel}
          placeholder={t("authoring.accountsPlaceholder")}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            add()
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || !value.trim()}
          onClick={add}
        >
          <PlusIcon aria-hidden className="size-4" />
          {addLabel}
        </Button>
      </div>
    </div>
  )
}
