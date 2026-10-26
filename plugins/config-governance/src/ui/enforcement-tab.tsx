"use client"

import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from "@cognia/plugin-ui"

import { describeMatcher } from "../adherence/checks"
import { validateRule, type EnforcementMode } from "../enforcement/rules"
import { PLUGIN_ID } from "../model"
import type { GovernanceRuntime, WorkspaceInfo } from "../runtime/runtime"
import { act } from "./act"
import type { GovernanceData } from "./use-governance"

export interface EnforcementTabProps {
  runtime: GovernanceRuntime
  data: GovernanceData
  workspaces: readonly WorkspaceInfo[]
  enforcementEnabled: boolean
}

export function EnforcementTab({
  runtime,
  data,
  workspaces,
  enforcementEnabled,
}: EnforcementTabProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const familyLabel = (family: string) => t(`family.${family}`)
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  return (
    <div className="space-y-3 p-3" data-testid="governance-enforcement">
      <p className="text-[11px] text-muted-foreground">{t("enforcement.hint")}</p>
      {!enforcementEnabled && (
        <Alert>
          <AlertDescription className="text-xs">
            {t("enforcement.disabledBySetting")}
          </AlertDescription>
        </Alert>
      )}
      {data.rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("enforcement.none")}</p>
      ) : (
        <ul className="space-y-2">
          {data.rules.map((rule) => {
            const valid = validateRule(rule)
            return (
              <li
                key={rule.id}
                className="space-y-1.5 rounded-md border p-2"
                data-rule-id={rule.id}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Switch
                    aria-label={t("enforcement.enabled")}
                    checked={rule.enabled}
                    onCheckedChange={(enabled) => act(runtime.updateRule(rule.id, { enabled }), t)}
                  />
                  <span className="text-xs font-medium">{rule.check.summary}</span>
                  {!valid && (
                    <Badge variant="destructive" className="text-[10px]">
                      {t("enforcement.invalid")}
                    </Badge>
                  )}
                  <Badge variant="outline" className="text-[10px]">
                    {rule.workspaceId === null
                      ? t("enforcement.everywhere")
                      : (names.get(rule.workspaceId) ?? rule.workspaceId)}
                  </Badge>
                  <Select
                    value={rule.mode}
                    onValueChange={(mode) =>
                      act(runtime.updateRule(rule.id, { mode: mode as EnforcementMode }), t)
                    }
                  >
                    <SelectTrigger
                      className="ml-auto h-7 w-28 text-xs"
                      aria-label={t("enforcement.modeLabel")}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="remind">{t("enforcement.mode.remind")}</SelectItem>
                      <SelectItem value="block">{t("enforcement.mode.block")}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => act(runtime.removeRule(rule.id), t)}
                  >
                    {t("enforcement.remove")}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {rule.check.rule.surfaceName}:{rule.check.rule.startLine} ·{" "}
                  {t(`checkKind.${rule.check.kind}`)} ·{" "}
                  {describeMatcher(rule.check.trigger, familyLabel)}
                  {rule.check.expect ? ` → ${describeMatcher(rule.check.expect, familyLabel)}` : ""}
                </p>
                {rule.mode === "block" && rule.check.kind === "require-after" && (
                  <p className="text-[11px] text-muted-foreground">
                    {t("enforcement.afterAlwaysReminds")}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
