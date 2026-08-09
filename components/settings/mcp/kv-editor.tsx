"use client"

import { PlusIcon, Trash2Icon } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"

import {
  EnvironmentVariable,
  EnvironmentVariableCopyButton,
  EnvironmentVariableGroup,
  EnvironmentVariables,
  EnvironmentVariablesContent,
  EnvironmentVariablesHeader,
  EnvironmentVariablesTitle,
  EnvironmentVariablesToggle,
} from "@/components/ai-elements/environment-variables"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { KvRow } from "./mcp-server-utils"

interface KvEditorProps {
  label: string
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
  /** Secret-bearing env editors start masked; ordinary HTTP headers remain visible. */
  maskValues?: boolean
}

export function KvEditor({
  label,
  rows,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  maskValues = false,
}: KvEditorProps) {
  const t = useTranslations("mcp.editor")
  const [showValues, setShowValues] = useState(!maskValues)

  const updateRow = (index: number, patch: Partial<KvRow>) => {
    onChange(rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)))
  }
  const removeRow = (index: number) => {
    onChange(rows.filter((_, rowIndex) => rowIndex !== index))
  }
  const addRow = () => {
    onChange([...rows, { key: "", value: "" }])
  }

  return (
    <EnvironmentVariables
      className="overflow-hidden rounded-md bg-transparent"
      onShowValuesChange={setShowValues}
      showValues={showValues}
    >
      <EnvironmentVariablesHeader className="px-2 py-1.5">
        <EnvironmentVariablesTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </EnvironmentVariablesTitle>
        <div className="flex items-center gap-1">
          {maskValues && (
            <EnvironmentVariablesToggle
              aria-label={showValues ? t("hideValues") : t("showValues")}
            />
          )}
          <Button
            className="h-6 px-2 text-[10px]"
            onClick={addRow}
            size="sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="mr-1 size-3" />
            {t("kvAdd")}
          </Button>
        </div>
      </EnvironmentVariablesHeader>
      <EnvironmentVariablesContent>
        {rows.length === 0 ? (
          <p className="px-2 py-2 text-[10px] italic text-muted-foreground">{t("kvEmpty")}</p>
        ) : (
          rows.map((row, index) => (
            <EnvironmentVariable
              className="gap-1 px-2 py-1"
              key={index}
              name={row.key}
              value={row.value}
            >
              <EnvironmentVariableGroup className="min-w-0 flex-1">
                <Input
                  className="h-7 flex-1 font-mono text-xs"
                  onChange={(event) => updateRow(index, { key: event.target.value })}
                  placeholder={keyPlaceholder}
                  value={row.key}
                />
                <Input
                  className="h-7 flex-[2] font-mono text-xs"
                  onChange={(event) => updateRow(index, { value: event.target.value })}
                  placeholder={valuePlaceholder}
                  type={maskValues && !showValues ? "password" : "text"}
                  value={row.value}
                />
              </EnvironmentVariableGroup>
              {maskValues && (
                <EnvironmentVariableCopyButton aria-label={t("copyValue")} copyFormat="value" />
              )}
              <Button
                aria-label={t("kvRemove")}
                className="size-7 text-muted-foreground hover:text-destructive"
                onClick={() => removeRow(index)}
                size="icon"
                type="button"
                variant="ghost"
              >
                <Trash2Icon className="size-3" />
              </Button>
            </EnvironmentVariable>
          ))
        )}
      </EnvironmentVariablesContent>
    </EnvironmentVariables>
  )
}
