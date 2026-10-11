"use client"

/**
 * Editor for the composable menu-bar title (ADR-0225 §11): an ordered list of
 * fields, each removable and movable, usage fields with their own window and
 * metric, and an add menu offering what the title does not show yet. The
 * line underneath is the title as it reads right now.
 */

import { useTranslations } from "next-intl"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  titleFieldKey,
  TRAY_TITLE_FIELD_KINDS,
  TRAY_TITLE_MAX_FIELDS,
  TRAY_TITLE_METRICS,
  TRAY_TITLE_PERIODS,
  type TrayTitleField,
  type TrayTitleFieldKind,
  type TrayTitleMetric,
  type TrayTitlePeriod,
} from "@/lib/tray/title-format"

/** The first usage window and metric the title does not show yet. */
function nextUsageField(fields: readonly TrayTitleField[]): TrayTitleField | null {
  const taken = new Set(fields.map(titleFieldKey))
  for (const metric of TRAY_TITLE_METRICS) {
    for (const period of TRAY_TITLE_PERIODS) {
      const field: TrayTitleField = { kind: "usage", period, metric }
      if (!taken.has(titleFieldKey(field))) return field
    }
  }
  return null
}

/** The field the add menu inserts for a kind, or null when it cannot be added. */
export function addableField(
  fields: readonly TrayTitleField[],
  kind: TrayTitleFieldKind
): TrayTitleField | null {
  if (fields.length >= TRAY_TITLE_MAX_FIELDS) return null
  if (kind === "usage") return nextUsageField(fields)
  return fields.some((field) => field.kind === kind) ? null : { kind }
}

export interface TrayTitleFieldsEditorProps {
  fields: readonly TrayTitleField[]
  onChange: (fields: TrayTitleField[]) => void
  /** The title as it reads now, or null when no field has anything to say. */
  preview: string | null
}

export function TrayTitleFieldsEditor({ fields, onChange, preview }: TrayTitleFieldsEditorProps) {
  const t = useTranslations("settings.tray.display.titleFields")

  const nameOf = (field: TrayTitleField) =>
    field.kind === "usage"
      ? t("usageName", { period: t(`period.${field.period}`), metric: t(`metric.${field.metric}`) })
      : t(`kind.${field.kind}`)

  const replace = (index: number, field: TrayTitleField) => {
    const next = fields.slice()
    next[index] = field
    // Two rows that became the same field collapse into the first.
    const seen = new Set<string>()
    onChange(
      next.filter((entry) => {
        const key = titleFieldKey(entry)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    )
  }

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= fields.length) return
    const next = fields.slice()
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  const remove = (index: number) => onChange(fields.filter((_, i) => i !== index))

  const addable = TRAY_TITLE_FIELD_KINDS.map((kind) => ({
    kind,
    field: addableField(fields, kind),
  })).filter((entry): entry is { kind: TrayTitleFieldKind; field: TrayTitleField } =>
    Boolean(entry.field)
  )

  return (
    <div className="space-y-2" data-testid="tray-title-fields">
      <div>
        <p className="text-sm font-medium">{t("label")}</p>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </div>

      {fields.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="tray-title-fields-empty">
          {t("empty")}
        </p>
      ) : (
        <ol className="divide-y rounded-md border">
          {fields.map((field, index) => {
            const name = nameOf(field)
            return (
              <li
                key={titleFieldKey(field)}
                className="flex flex-wrap items-center gap-2 px-2 py-1.5"
                data-testid={`tray-title-field-${titleFieldKey(field)}`}
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {field.kind === "usage" ? t("kind.usage") : name}
                </span>
                {field.kind === "usage" ? (
                  <>
                    <Select
                      value={field.period}
                      onValueChange={(period) =>
                        replace(index, { ...field, period: period as TrayTitlePeriod })
                      }
                    >
                      <SelectTrigger
                        className="h-8 w-28"
                        aria-label={t("periodLabel", { field: name })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRAY_TITLE_PERIODS.map((period) => (
                          <SelectItem key={period} value={period}>
                            {t(`period.${period}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={field.metric}
                      onValueChange={(metric) =>
                        replace(index, { ...field, metric: metric as TrayTitleMetric })
                      }
                    >
                      <SelectTrigger
                        className="h-8 w-28"
                        aria-label={t("metricLabel", { field: name })}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TRAY_TITLE_METRICS.map((metric) => (
                          <SelectItem key={metric} value={metric}>
                            {t(`metric.${metric}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : null}
                <div className="flex items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={index === 0}
                    aria-label={t("moveUp", { field: name })}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUpIcon className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    disabled={index === fields.length - 1}
                    aria-label={t("moveDown", { field: name })}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDownIcon className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    aria-label={t("remove", { field: name })}
                    onClick={() => remove(index)}
                  >
                    <XIcon className="size-4" />
                  </Button>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={addable.length === 0}
              data-testid="tray-title-add"
            >
              <PlusIcon className="size-4" />
              {t("add")}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {addable.map(({ kind, field }) => (
              <DropdownMenuItem key={kind} onSelect={() => onChange([...fields, field])}>
                {t(`kind.${kind}`)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        {fields.length >= TRAY_TITLE_MAX_FIELDS ? (
          <span className="text-xs text-muted-foreground">
            {t("max", { max: TRAY_TITLE_MAX_FIELDS })}
          </span>
        ) : null}
      </div>

      <p className="truncate text-xs text-muted-foreground" data-testid="tray-title-preview">
        {preview ? t("preview", { text: preview }) : t("previewEmpty")}
      </p>
    </div>
  )
}
