"use client"

// The declaration controls for one `{{token}}` in the body.
//
// A token carries only its id; everything else — the label the popover shows,
// whether a send may skip it, whether it wants free text, a closed list, or
// a workspace reference — is declared here. Editing the body re-derives the
// LIST (`deriveParams`); this row edits what the derivation cannot know.

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  paramKindChange,
  type ChatTemplateParam,
  type ChatTemplateParamKind,
} from "@/lib/chat/template/template"
import { RESOURCE_PARAM_KINDS, type ResourceParamKind } from "@/lib/chat/template/resource-kinds"
import { cn } from "@/lib/utils"

export function ParamDeclarationRow({
  param,
  mobile,
  onPatch,
}: {
  param: ChatTemplateParam
  mobile: boolean
  onPatch(patch: Partial<ChatTemplateParam>): void
}) {
  const t = useTranslations("chatTemplatesSettings")

  return (
    <div className="space-y-2 rounded-md border p-2" data-testid={`param-row-${param.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary" className="shrink-0 font-mono text-xs">
          {param.id}
        </Badge>
        <Input
          className={cn("h-8 min-w-0", mobile ? "w-full" : "flex-1")}
          aria-label={t("paramLabel")}
          value={param.label}
          onChange={(event) => onPatch({ label: event.target.value })}
        />
        <Select
          value={param.kind}
          onValueChange={(kind) => onPatch(paramKindChange(param, kind as ChatTemplateParamKind))}
        >
          <SelectTrigger className="h-8 w-32" aria-label={t("paramKind")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="string">{t("kindString")}</SelectItem>
            <SelectItem value="enum">{t("kindEnum")}</SelectItem>
            <SelectItem value="resource">{t("kindResource")}</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
          <Checkbox
            checked={param.required}
            onCheckedChange={(checked) => onPatch({ required: checked === true })}
          />
          {t("paramRequired")}
        </label>
      </div>
      {/* The sentence the fill popover shows under the label — what belongs in
          this slot, in the writer's own words. Travels in the .md frontmatter
          (`description`) and surfaces in the composer unchanged. */}
      <Input
        className="h-8 text-xs"
        aria-label={t("paramHint")}
        placeholder={t("paramHintPlaceholder")}
        value={param.description ?? ""}
        onChange={(event) => onPatch({ description: event.target.value || undefined })}
      />
      {param.kind === "resource" ? (
        <Select
          value={param.resourceKind ?? "file"}
          onValueChange={(resourceKind) =>
            onPatch({ resourceKind: resourceKind as ResourceParamKind })
          }
        >
          <SelectTrigger
            className={cn("h-8", mobile ? "w-full" : "w-48")}
            aria-label={t("paramResource")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RESOURCE_PARAM_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {t(
                  `resource${kind.charAt(0).toUpperCase()}${kind.slice(1)}` as
                    "resourceFile" | "resourceAgent" | "resourceSubagent" | "resourceMember"
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : param.kind === "enum" ? (
        <div className="space-y-1">
          <Textarea
            className="min-h-16 text-xs"
            aria-label={t("paramOptions")}
            value={(param.options ?? []).join("\n")}
            onChange={(event) =>
              onPatch({
                options: event.target.value
                  .split("\n")
                  .map((line) => line.trim())
                  .filter(Boolean),
              })
            }
          />
          <p className="text-xs text-muted-foreground">{t("paramOptionsHint")}</p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className={cn("h-8 min-w-0", mobile ? "w-full" : "flex-1")}
            aria-label={t("paramDefault")}
            placeholder={t("paramDefault")}
            value={param.defaultValue ?? ""}
            onChange={(event) => onPatch({ defaultValue: event.target.value || undefined })}
          />
          <label className="flex shrink-0 items-center gap-1.5 text-xs">
            <Checkbox
              checked={param.multiline === true}
              onCheckedChange={(checked) => onPatch({ multiline: checked === true })}
            />
            {t("paramMultiline")}
          </label>
        </div>
      )}
    </div>
  )
}
