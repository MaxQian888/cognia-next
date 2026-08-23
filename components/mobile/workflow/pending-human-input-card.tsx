"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ClipboardPenLineIcon, UploadIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { uploadSessionAttachment } from "@/lib/companion/attachment-upload-client"
import { transport } from "@/lib/tauri/transport-instance"
import { cn } from "@/lib/utils"
import type {
  HumanInputAction,
  HumanInputField,
  HumanInputValue,
} from "@/types/workflow/human-input"

export interface PendingHumanInputRow {
  id: string
  status: "pending"
  runId: string
  workflowId: string
  stepId: string
  title: string
  message?: string
  fields: HumanInputField[]
  actions: HumanInputAction[]
  completionPolicy: { mode: "any" | "all" | "quorum"; count?: number }
  createdAt: number
  expiresAt: number
}

export const HUMAN_INPUT_EVENT_CHANNELS = [
  "workflow://human-input-request",
  "workflow://human-input-resolved",
] as const

type ValuesByRequest = Record<string, Record<string, HumanInputValue>>
type ErrorsByRequest = Record<string, Record<string, string>>

function initialValue(field: HumanInputField): HumanInputValue {
  if (field.type === "boolean") return false
  if (field.type === "multi-select" || field.type === "file-list") return []
  return null
}

function validateValues(
  fields: HumanInputField[],
  values: Record<string, HumanInputValue>,
  t: ReturnType<typeof useTranslations>
): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const field of fields) {
    const value = values[field.id] ?? initialValue(field)
    const empty =
      value === null ||
      value === "" ||
      value === false ||
      (Array.isArray(value) && value.length === 0)
    if (field.required && empty) {
      errors[field.id] = t("requiredError", { field: field.label })
      continue
    }
    if (field.type === "number" && typeof value === "number") {
      if (field.min !== undefined && value < field.min) {
        errors[field.id] = t("numberMinError", { field: field.label, min: field.min })
      } else if (field.max !== undefined && value > field.max) {
        errors[field.id] = t("numberMaxError", { field: field.label, max: field.max })
      }
    }
  }
  return errors
}

function actionVariant(action: HumanInputAction): "default" | "outline" | "destructive" {
  if (action.tone === "destructive") return "destructive"
  if (action.tone === "secondary") return "outline"
  return "default"
}

async function readFileBytes(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === "function") {
    return new Uint8Array(await file.arrayBuffer())
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read selected file"))
    reader.onload = () => {
      if (!(reader.result instanceof ArrayBuffer)) {
        reject(new Error("Selected file did not produce bytes"))
        return
      }
      resolve(new Uint8Array(reader.result))
    }
    reader.readAsArrayBuffer(file)
  })
}

export function PendingHumanInputCard({ className }: { className?: string }) {
  const t = useTranslations("mobile.workflow.humanInput")
  const [requests, setRequests] = useState<PendingHumanInputRow[]>([])
  const [valuesByRequest, setValuesByRequest] = useState<ValuesByRequest>({})
  const [errorsByRequest, setErrorsByRequest] = useState<ErrorsByRequest>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [uploadingKey, setUploadingKey] = useState<string | null>(null)
  const [respondedIds, setRespondedIds] = useState<ReadonlySet<string>>(new Set())

  const reload = useCallback(async () => {
    try {
      const result = (await transport.call("workflow_human_input_list", {})) as {
        requests?: PendingHumanInputRow[]
      } | null
      setRequests(Array.isArray(result?.requests) ? result.requests : [])
    } catch {
      // Preserve the last durable view while the paired desktop is unreachable.
    }
  }, [])

  useEffect(() => {
    const kickoff = setTimeout(() => void reload(), 0)
    const unsubs = HUMAN_INPUT_EVENT_CHANNELS.map((channel) =>
      transport.subscribe(channel, () => void reload())
    )
    return () => {
      clearTimeout(kickoff)
      for (const unsubscribe of unsubs) unsubscribe()
    }
  }, [reload])

  const setValue = useCallback((requestId: string, fieldId: string, value: HumanInputValue) => {
    setValuesByRequest((current) => ({
      ...current,
      [requestId]: { ...current[requestId], [fieldId]: value },
    }))
    setErrorsByRequest((current) => {
      if (!current[requestId]?.[fieldId]) return current
      const requestErrors = { ...current[requestId] }
      delete requestErrors[fieldId]
      return { ...current, [requestId]: requestErrors }
    })
  }, [])

  const uploadFiles = useCallback(
    async (request: PendingHumanInputRow, field: HumanInputField, files: FileList | null) => {
      if (!files || files.length === 0) return
      const selected = Array.from(files).slice(0, field.type === "file-list" ? field.maxFiles : 1)
      const uploadKey = `${request.id}:${field.id}`
      setUploadingKey(uploadKey)
      try {
        const uploaded: string[] = []
        for (const file of selected) {
          const bytes = await readFileBytes(file)
          const result = await uploadSessionAttachment(
            `human-input:${request.id}`,
            { name: file.name, mediaType: file.type || "application/octet-stream", bytes },
            { onProgress: () => undefined }
          )
          uploaded.push(result.ref)
        }
        setValue(
          request.id,
          field.id,
          field.type === "file-list" ? uploaded : (uploaded[0] ?? null)
        )
      } catch {
        toast.error(t("uploadFailedToast"))
      } finally {
        setUploadingKey(null)
      }
    },
    [setValue, t]
  )

  const submit = useCallback(
    async (request: PendingHumanInputRow, actionId: string) => {
      const values = Object.fromEntries(
        request.fields.map((field) => [
          field.id,
          valuesByRequest[request.id]?.[field.id] ?? initialValue(field),
        ])
      ) as Record<string, HumanInputValue>
      const errors = validateValues(request.fields, values, t)
      if (Object.keys(errors).length > 0) {
        setErrorsByRequest((current) => ({ ...current, [request.id]: errors }))
        return
      }

      setBusyId(request.id)
      try {
        const result = (await transport.call("workflow_human_input_submit", {
          requestId: request.id,
          actionId,
          values,
        })) as { ok?: boolean; completed?: boolean; reason?: string; message?: string } | null
        if (!result?.ok) {
          if (result?.reason === "not-found" || result?.reason === "not-pending") {
            toast.info(t("goneToast"))
            void reload()
          } else {
            toast.error(result?.message || t("submitRejectedToast"))
          }
          return
        }
        if (result.completed) {
          setRequests((current) => current.filter((item) => item.id !== request.id))
          toast.success(t("submittedToast"))
        } else {
          setRespondedIds((current) => new Set(current).add(request.id))
          toast.info(t("waitingForOthersToast"))
        }
      } catch {
        toast.error(t("submitFailedToast"))
      } finally {
        setBusyId(null)
      }
    },
    [reload, t, valuesByRequest]
  )

  if (requests.length === 0) return null

  return (
    <Card className={cn("space-y-4 p-3", className)} data-testid="pending-human-input-card">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <ClipboardPenLineIcon className="size-4 text-blue-500" aria-hidden="true" />
        {t("heading", { count: requests.length })}
      </div>
      <ul className="space-y-4">
        {requests.map((request) => {
          const requestValues = valuesByRequest[request.id] ?? {}
          const requestErrors = errorsByRequest[request.id] ?? {}
          const responded = respondedIds.has(request.id)
          return (
            <li
              key={request.id}
              className="space-y-3 border-t pt-3 first:border-t-0 first:pt-0"
              data-testid={`human-input-${request.id}`}
            >
              <div className="space-y-1">
                <p className="text-sm font-medium leading-tight">{request.title}</p>
                {request.message ? (
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">
                    {request.message}
                  </p>
                ) : null}
              </div>

              <div className="space-y-3">
                {request.fields.map((field) => {
                  const controlId = `human-input-${request.id}-${field.id}`
                  const value = requestValues[field.id] ?? initialValue(field)
                  const error = requestErrors[field.id]
                  const label = field.required ? `${field.label} *` : field.label
                  return (
                    <div key={field.id} className="space-y-1.5">
                      {field.type !== "boolean" ? (
                        <Label htmlFor={controlId} className="text-xs">
                          {label}
                        </Label>
                      ) : null}
                      {field.description ? (
                        <p className="text-xs text-muted-foreground">{field.description}</p>
                      ) : null}

                      {field.type === "short-text" ? (
                        <Input
                          id={controlId}
                          value={typeof value === "string" ? value : ""}
                          aria-invalid={Boolean(error)}
                          onChange={(event) => setValue(request.id, field.id, event.target.value)}
                        />
                      ) : null}
                      {field.type === "long-text" ? (
                        <Textarea
                          id={controlId}
                          rows={3}
                          value={typeof value === "string" ? value : ""}
                          aria-invalid={Boolean(error)}
                          onChange={(event) => setValue(request.id, field.id, event.target.value)}
                        />
                      ) : null}
                      {field.type === "number" ? (
                        <Input
                          id={controlId}
                          type="number"
                          min={field.min}
                          max={field.max}
                          value={typeof value === "number" ? String(value) : ""}
                          aria-invalid={Boolean(error)}
                          onChange={(event) =>
                            setValue(
                              request.id,
                              field.id,
                              event.target.value === "" ? null : Number(event.target.value)
                            )
                          }
                        />
                      ) : null}
                      {field.type === "boolean" ? (
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={controlId}
                            checked={value === true}
                            aria-invalid={Boolean(error)}
                            onCheckedChange={(checked) =>
                              setValue(request.id, field.id, checked === true)
                            }
                          />
                          <Label htmlFor={controlId} className="text-xs">
                            {label}
                          </Label>
                        </div>
                      ) : null}
                      {field.type === "single-select" ? (
                        <NativeSelect
                          id={controlId}
                          wrapperClassName="w-full"
                          value={typeof value === "string" ? value : ""}
                          aria-invalid={Boolean(error)}
                          onChange={(event) => setValue(request.id, field.id, event.target.value)}
                        >
                          <NativeSelectOption value="">{t("selectPlaceholder")}</NativeSelectOption>
                          {(field.options ?? []).map((option) => (
                            <NativeSelectOption key={option.value} value={option.value}>
                              {option.label}
                            </NativeSelectOption>
                          ))}
                        </NativeSelect>
                      ) : null}
                      {field.type === "multi-select" ? (
                        <div className="space-y-2" role="group" aria-label={field.label}>
                          {(field.options ?? []).map((option) => {
                            const selected = Array.isArray(value) && value.includes(option.value)
                            const optionId = `${controlId}-${option.value}`
                            return (
                              <div key={option.value} className="flex items-center gap-2">
                                <Checkbox
                                  id={optionId}
                                  checked={selected}
                                  onCheckedChange={(checked) => {
                                    const current = Array.isArray(value) ? value : []
                                    setValue(
                                      request.id,
                                      field.id,
                                      checked === true
                                        ? [...current.filter((item) => item !== option.value), option.value]
                                        : current.filter((item) => item !== option.value)
                                    )
                                  }}
                                />
                                <Label htmlFor={optionId} className="text-xs">
                                  {option.label}
                                </Label>
                              </div>
                            )
                          })}
                        </div>
                      ) : null}
                      {field.type === "file" || field.type === "file-list" ? (
                        <div className="space-y-1.5">
                          <Input
                            id={controlId}
                            type="file"
                            accept={field.accept?.join(",")}
                            multiple={field.type === "file-list"}
                            aria-invalid={Boolean(error)}
                            disabled={uploadingKey === `${request.id}:${field.id}`}
                            onChange={(event) => void uploadFiles(request, field, event.target.files)}
                          />
                          {uploadingKey === `${request.id}:${field.id}` ? (
                            <p className="flex items-center gap-1 text-xs text-muted-foreground">
                              <UploadIcon className="size-3" aria-hidden="true" />
                              {t("uploading")}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                      {error ? (
                        <p className="text-xs text-destructive" role="alert">
                          {error}
                        </p>
                      ) : null}
                    </div>
                  )
                })}
              </div>

              {responded ? (
                <p className="text-xs font-medium text-muted-foreground">{t("responded")}</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {request.actions.map((action) => (
                    <Button
                      key={action.id}
                      size="sm"
                      variant={actionVariant(action)}
                      disabled={busyId === request.id || uploadingKey?.startsWith(`${request.id}:`)}
                      onClick={() => void submit(request, action.id)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
