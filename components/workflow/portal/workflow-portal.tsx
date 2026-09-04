"use client"

import { useEffect, useMemo, useState } from "react"
import { useSearchParams } from "next/navigation"
import { createPlatformFetch } from "@/lib/network/platform-fetch"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import type { WorkflowAppBlock, WorkflowAppLocalizedContent } from "@/types/workflow/app"
import type {
  HumanInputAction,
  HumanInputField,
  HumanInputValue,
} from "@/types/workflow/human-input"

interface PortalAppManifest {
  slug: string
  kind: "workflow" | "chatflow"
  releaseId: string
  blocks: WorkflowAppBlock[]
  localized: Partial<Record<"en" | "zh-CN", WorkflowAppLocalizedContent>>
  theme: { primaryColor: string; logoUrl?: string }
  inputSchema?: {
    type?: string
    properties?: Record<
      string,
      {
        type?: "string" | "number" | "integer" | "boolean"
        title?: string
        description?: string
        enum?: Array<string | number>
        format?: string
        default?: unknown
      }
    >
    required?: string[]
  }
  legal: { requireConsent: boolean; termsUrl?: string; privacyUrl?: string }
  resultSharing?: { enabled: boolean; defaultTtlSeconds?: number }
}

interface PortalBootstrap {
  app: PortalAppManifest
  sessionToken: string
  recoveryKey?: string
}

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  text: string
}

interface PortalBatchJob {
  id: string
  status:
    | "queued"
    | "running"
    | "pausing"
    | "paused"
    | "cancelling"
    | "cancelled"
    | "completed"
    | "failed"
  totalRows: number
  queuedRows: number
  activeRows: number
  waitingRows: number
  succeededRows: number
  failedRows: number
  cancelledRows: number
}

interface PortalBatchPage {
  job: PortalBatchJob
}

interface PortalFeedbackTarget {
  input: string
  output: string
  runId?: string
  conversationId?: string
  messageId?: string
}

interface PortalResultShare {
  code: string
  url: string
  expiresAt?: number
}

interface PortalEmbedSession {
  token: string
  parentOrigin: string
}

interface PortalHumanInputRequest {
  id: string
  title: string
  message?: string
  fields: HumanInputField[]
  actions: HumanInputAction[]
  completionPolicy: { mode: "any" | "all" | "quorum"; count?: number }
  submittedCount: number
  createdAt: number
  expiresAt: number
}

interface AnonymousChallengeEnvelope {
  code?: string
  details?: {
    challengeToken?: string
    difficulty?: number
    algorithm?: string
    expiresAt?: number
  }
}

function digestHasLeadingZeroBits(digest: Uint8Array, difficulty: number): boolean {
  let remaining = difficulty
  for (const byte of digest) {
    if (remaining <= 0) return true
    if (remaining >= 8) {
      if (byte !== 0) return false
      remaining -= 8
      continue
    }
    return byte >> (8 - remaining) === 0
  }
  return remaining <= 0
}

async function solveAnonymousChallenge(token: string, difficulty: number): Promise<string> {
  for (let proof = 0; proof < Number.MAX_SAFE_INTEGER; proof += 1) {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${token}:${proof}`))
    )
    if (digestHasLeadingZeroBits(digest, difficulty)) return String(proof)
  }
  throw new Error("anonymous_challenge_unsolved")
}

/**
 * Every portal request goes through the shell's transport rather than bare
 * `fetch`.
 *
 * Off Tauri and Capacitor `createPlatformFetch()` IS `(input, init) =>
 * fetch(input, init)`, so the public page behaves exactly as before. It matters
 * because the portal also renders in embed mode inside the desktop shell, where
 * bare fetch would make this the one surface that ignored the configured proxy.
 */
function portalFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return createPlatformFetch()(input, init)
}

/** Retry one execution mutation after solving a server-issued adaptive challenge. */
export async function fetchWithAnonymousChallenge(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const response = await portalFetch(input, init)
  if (response.status !== 429) return response
  const envelope = (await response
    .clone()
    .json()
    .catch(() => null)) as AnonymousChallengeEnvelope | null
  const offer = envelope?.details
  if (
    envelope?.code !== "anonymous_challenge_required" ||
    typeof offer?.challengeToken !== "string" ||
    !Number.isInteger(offer.difficulty) ||
    (offer.difficulty as number) < 1 ||
    (offer.difficulty as number) > 24 ||
    offer.algorithm !== "sha256-leading-zero-bits" ||
    typeof offer.expiresAt !== "number" ||
    offer.expiresAt * 1_000 <= Date.now()
  ) {
    return response
  }
  const proof = await solveAnonymousChallenge(offer.challengeToken, offer.difficulty as number)
  const headers = new Headers(init?.headers)
  headers.set("x-cognia-challenge-token", offer.challengeToken)
  headers.set("x-cognia-challenge-proof", proof)
  return portalFetch(input, { ...init, headers })
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error("file_read_failed"))
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "")
    reader.readAsText(file)
  })
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}

function safeApiBase(input: string | null): string {
  if (!input) return ""
  try {
    const parsed = new URL(input)
    return parsed.protocol === "https:" || parsed.hostname === "localhost" ? parsed.origin : ""
  } catch {
    return ""
  }
}

function safeResultShareUrl(input: string): string | undefined {
  try {
    const parsed = new URL(input)
    return parsed.protocol === "https:" || parsed.hostname === "localhost" ? parsed.href : undefined
  } catch {
    return undefined
  }
}

function localizedContent(app: PortalAppManifest): WorkflowAppLocalizedContent {
  if (typeof navigator !== "undefined" && navigator.language.toLocaleLowerCase().startsWith("zh")) {
    return app.localized["zh-CN"] ?? app.localized.en ?? { title: app.slug }
  }
  return app.localized.en ?? app.localized["zh-CN"] ?? { title: app.slug }
}

function isMissingHumanInputValue(value: HumanInputValue | undefined): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim().length === 0
  return Array.isArray(value) && value.length === 0
}

function feedbackText(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? String(value)
}

export function WorkflowPortal() {
  const t = useTranslations("workflowPortal")
  const loadFailedMessage = t("loadFailed")
  const humanInputLoadFailedMessage = t("humanInputLoadFailed")
  const search = useSearchParams()
  const appSlug = search.get("app")?.trim() ?? ""
  const apiBase = safeApiBase(search.get("api"))
  const embedMode = search.get("embed") === "1"
  const [embedSession, setEmbedSession] = useState<PortalEmbedSession>()
  const [bootstrap, setBootstrap] = useState<PortalBootstrap | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [consented, setConsented] = useState(false)
  const [result, setResult] = useState<unknown>()
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [chatInput, setChatInput] = useState("")
  const [conversationId, setConversationId] = useState<string>()
  const [conversationRevision, setConversationRevision] = useState<number>()
  const [batchFile, setBatchFile] = useState<File>()
  const [batchJob, setBatchJob] = useState<PortalBatchJob>()
  const [batchBusy, setBatchBusy] = useState(false)
  const [humanInputRequests, setHumanInputRequests] = useState<PortalHumanInputRequest[]>([])
  const [humanInputValues, setHumanInputValues] = useState<
    Record<string, Record<string, HumanInputValue>>
  >({})
  const [humanInputBusy, setHumanInputBusy] = useState<Set<string>>(() => new Set())
  const [feedbackTarget, setFeedbackTarget] = useState<PortalFeedbackTarget>()
  const [feedbackRating, setFeedbackRating] = useState<"like" | "dislike">()
  const [feedbackTags, setFeedbackTags] = useState("")
  const [feedbackCorrection, setFeedbackCorrection] = useState("")
  const [feedbackBusy, setFeedbackBusy] = useState(false)
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false)
  const [resultShare, setResultShare] = useState<PortalResultShare>()
  const [resultShareBusy, setResultShareBusy] = useState(false)
  const content = bootstrap ? localizedContent(bootstrap.app) : undefined
  const portalAppSlug = bootstrap?.app.slug ?? appSlug

  useEffect(() => {
    if (!embedMode) return
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return
      const message = event.data as Record<string, unknown>
      if (
        message.type !== "cognia.workflow-app.init" ||
        message.version !== 1 ||
        typeof message.sessionToken !== "string" ||
        !message.sessionToken ||
        message.parentOrigin !== event.origin
      ) {
        return
      }
      setEmbedSession({ token: message.sessionToken, parentOrigin: event.origin })
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [embedMode])

  useEffect(() => {
    if (embedMode && !embedSession) return
    const controller = new AbortController()
    const sessionKey = appSlug
      ? `cognia:portal:${appSlug}:token`
      : "cognia:portal:custom-domain:token"
    const storedToken = embedMode ? embedSession?.token : sessionStorage.getItem(sessionKey)
    const bootstrapUrl = appSlug
      ? `${apiBase}/api/apps/${encodeURIComponent(appSlug)}/bootstrap`
      : `${apiBase}/api/portal/bootstrap`
    void portalFetch(bootstrapUrl, {
      headers: storedToken ? { Authorization: `Bearer ${storedToken}` } : {},
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(loadFailedMessage)
        return (await response.json()) as PortalBootstrap
      })
      .then((next) => {
        if (!embedMode) sessionStorage.setItem(sessionKey, next.sessionToken)
        setBootstrap(next)
        setValues(
          Object.fromEntries(
            Object.entries(next.app.inputSchema?.properties ?? {}).flatMap(([key, property]) =>
              property.default === undefined ? [] : [[key, property.default]]
            )
          )
        )
        if (embedSession) {
          window.parent.postMessage(
            {
              type: "cognia.workflow-app.ready",
              version: 1,
              releaseId: next.app.releaseId,
            },
            embedSession.parentOrigin
          )
        }
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [apiBase, appSlug, embedMode, embedSession, loadFailedMessage])

  const required = useMemo(() => new Set(bootstrap?.app.inputSchema?.required ?? []), [bootstrap])
  const missingRequired = [...required].some((key) => {
    const value = values[key]
    return value === undefined || value === null || value === ""
  })
  const legalBlocked = Boolean(bootstrap?.app.legal.requireConsent && !consented)

  useEffect(() => {
    if (!bootstrap || !batchJob || ["completed", "cancelled", "failed"].includes(batchJob.status)) {
      return
    }
    const controller = new AbortController()
    const poll = async () => {
      try {
        const response = await portalFetch(
          `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/batches/${encodeURIComponent(batchJob.id)}`,
          {
            headers: { Authorization: `Bearer ${bootstrap.sessionToken}` },
            signal: controller.signal,
          }
        )
        if (!response.ok) throw new Error(t("batchStatusFailed"))
        const page = (await response.json()) as PortalBatchPage
        setBatchJob(page.job)
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }
    const timer = window.setInterval(() => void poll(), 1_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [apiBase, batchJob, bootstrap, portalAppSlug, t])

  useEffect(() => {
    if (!bootstrap) return
    const controller = new AbortController()
    const refresh = async () => {
      try {
        const response = await portalFetch(
          `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/human-input`,
          {
            headers: { Authorization: `Bearer ${bootstrap.sessionToken}` },
            signal: controller.signal,
          }
        )
        if (!response.ok) throw new Error(humanInputLoadFailedMessage)
        setHumanInputRequests((await response.json()) as PortalHumanInputRequest[])
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : String(caught))
        }
      }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5_000)
    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [apiBase, bootstrap, humanInputLoadFailedMessage, portalAppSlug])

  const setHumanInputValue = (requestId: string, fieldId: string, value: HumanInputValue) => {
    setHumanInputValues((current) => ({
      ...current,
      [requestId]: { ...current[requestId], [fieldId]: value },
    }))
  }

  const setHumanInputOperation = (operationId: string, busy: boolean) => {
    setHumanInputBusy((current) => {
      const next = new Set(current)
      if (busy) next.add(operationId)
      else next.delete(operationId)
      return next
    })
  }

  const uploadHumanInputFiles = async (
    request: PortalHumanInputRequest,
    field: HumanInputField,
    selected: FileList | null
  ) => {
    if (!bootstrap || !selected?.length) return
    const operationId = `${request.id}:${field.id}`
    const currentValue = humanInputValues[request.id]?.[field.id]
    const currentRefs = Array.isArray(currentValue) ? currentValue : []
    const remaining =
      field.type === "file-list" ? Math.max(0, (field.maxFiles ?? 10) - currentRefs.length) : 1
    const files = Array.from(selected).slice(0, remaining)
    if (!files.length) return
    setHumanInputOperation(operationId, true)
    setError(null)
    try {
      const uploadedRefs: string[] = []
      for (const file of files) {
        const form = new FormData()
        form.append("fieldId", field.id)
        form.append("file", file)
        const response = await portalFetch(
          `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/human-input/${encodeURIComponent(request.id)}/files`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${bootstrap.sessionToken}` },
            body: form,
          }
        )
        if (!response.ok) throw new Error(t("humanInputUploadFailed"))
        const uploaded = (await response.json()) as { ref: string }
        uploadedRefs.push(uploaded.ref)
      }
      setHumanInputValue(
        request.id,
        field.id,
        field.type === "file-list" ? [...currentRefs, ...uploadedRefs] : uploadedRefs[0]!
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setHumanInputOperation(operationId, false)
    }
  }

  const submitHumanInputRequest = async (request: PortalHumanInputRequest, actionId: string) => {
    if (!bootstrap) return
    const operationId = `${request.id}:submit`
    setHumanInputOperation(operationId, true)
    setError(null)
    try {
      const response = await portalFetch(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/human-input/${encodeURIComponent(request.id)}/submit`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bootstrap.sessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ actionId, values: humanInputValues[request.id] ?? {} }),
        }
      )
      if (!response.ok) throw new Error(t("humanInputSubmitFailed"))
      setHumanInputRequests((current) => current.filter((item) => item.id !== request.id))
      setHumanInputValues((current) => {
        const next = { ...current }
        delete next[request.id]
        return next
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setHumanInputOperation(operationId, false)
    }
  }

  const runWorkflow = async () => {
    if (!bootstrap) return
    setError(null)
    const response = await fetchWithAnonymousChallenge(
      `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/runs`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bootstrap.sessionToken}`,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          input: values,
          legalConsentGranted: consented,
          responseMode: "blocking",
        }),
      }
    )
    if (!response.ok) throw new Error(t("runFailed"))
    const body = (await response.json()) as { runId?: string; output?: unknown }
    setResult(body)
    setFeedbackTarget({
      input: feedbackText(values),
      output: feedbackText(body.output ?? body),
      ...(body.runId ? { runId: body.runId } : {}),
    })
    setFeedbackRating(undefined)
    setFeedbackTags("")
    setFeedbackCorrection("")
    setFeedbackSubmitted(false)
    setResultShare(undefined)
  }

  const sendMessage = async () => {
    if (!bootstrap || !chatInput.trim()) return
    const text = chatInput.trim()
    setChatInput("")
    setMessages((current) => [...current, { id: crypto.randomUUID(), role: "user", text }])
    try {
      const response = await fetchWithAnonymousChallenge(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/chat-messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bootstrap.sessionToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            query: text,
            ...(conversationId ? { conversationId } : {}),
            ...(conversationRevision !== undefined
              ? { expectedRevision: conversationRevision }
              : {}),
            legalConsentGranted: consented,
          }),
        }
      )
      if (!response.ok) throw new Error(t("messageFailed"))
      const body = (await response.json()) as {
        conversationId: string
        conversationRevision: number
        messageId: string
        runId: string
        answer: { text?: string; content?: unknown }
      }
      setConversationId(body.conversationId)
      setConversationRevision(body.conversationRevision)
      setMessages((current) => [
        ...current,
        {
          id: body.messageId,
          role: "assistant",
          text: body.answer.text ?? JSON.stringify(body.answer.content ?? null),
        },
      ])
      setFeedbackTarget({
        input: text,
        output: body.answer.text ?? feedbackText(body.answer.content ?? null),
        runId: body.runId,
        conversationId: body.conversationId,
        messageId: body.messageId,
      })
      setFeedbackRating(undefined)
      setFeedbackTags("")
      setFeedbackCorrection("")
      setFeedbackSubmitted(false)
      setResultShare(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const downloadBatchTemplate = async () => {
    if (!bootstrap) return
    setBatchBusy(true)
    try {
      const response = await portalFetch(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/batch-template`,
        { headers: { Authorization: `Bearer ${bootstrap.sessionToken}` } }
      )
      if (!response.ok) throw new Error(t("batchTemplateFailed"))
      downloadBlob(await response.blob(), `${portalAppSlug}-batch-template.csv`)
    } finally {
      setBatchBusy(false)
    }
  }

  const startBatch = async () => {
    if (!bootstrap || !batchFile) return
    setBatchBusy(true)
    setError(null)
    try {
      const response = await fetchWithAnonymousChallenge(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/batches`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bootstrap.sessionToken}`,
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          },
          body: JSON.stringify({
            csv: await readFileText(batchFile),
            legalConsentGranted: consented,
          }),
        }
      )
      if (!response.ok) throw new Error(t("batchStartFailed"))
      setBatchJob((await response.json()) as PortalBatchJob)
    } finally {
      setBatchBusy(false)
    }
  }

  const batchAction = async (action: "pause" | "resume" | "cancel") => {
    if (!bootstrap || !batchJob) return
    setBatchBusy(true)
    try {
      const response = await portalFetch(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/batches/${encodeURIComponent(batchJob.id)}/${action}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${bootstrap.sessionToken}` },
        }
      )
      if (!response.ok) throw new Error(t("batchActionFailed"))
      setBatchJob((await response.json()) as PortalBatchJob)
    } finally {
      setBatchBusy(false)
    }
  }

  const exportBatch = async () => {
    if (!bootstrap || !batchJob) return
    setBatchBusy(true)
    try {
      const response = await portalFetch(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/batches/${encodeURIComponent(batchJob.id)}/export`,
        { headers: { Authorization: `Bearer ${bootstrap.sessionToken}` } }
      )
      if (!response.ok) throw new Error(t("batchExportFailed"))
      downloadBlob(await response.blob(), `${portalAppSlug}-batch-results.csv`)
    } finally {
      setBatchBusy(false)
    }
  }

  const submitFeedback = async () => {
    if (!bootstrap || !feedbackTarget || !feedbackRating) return
    setFeedbackBusy(true)
    setError(null)
    try {
      const correction = feedbackCorrection.trim()
      const response = await portalFetch(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/feedback`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bootstrap.sessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            rating: feedbackRating,
            input: feedbackTarget.input,
            output: feedbackTarget.output,
            ...(correction ? { correction } : {}),
            tags: feedbackTags
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean),
            ...(feedbackTarget.runId ? { runId: feedbackTarget.runId } : {}),
            ...(feedbackTarget.conversationId
              ? { conversationId: feedbackTarget.conversationId }
              : {}),
            ...(feedbackTarget.messageId ? { messageId: feedbackTarget.messageId } : {}),
            legalConsentGranted: consented,
          }),
        }
      )
      if (!response.ok) throw new Error(t("feedbackSubmitFailed"))
      setFeedbackSubmitted(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setFeedbackBusy(false)
    }
  }

  const createResultShare = async () => {
    if (!bootstrap || !feedbackTarget?.runId) return
    setResultShareBusy(true)
    setError(null)
    try {
      const response = await portalFetch(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/runs/${encodeURIComponent(feedbackTarget.runId)}/shares`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bootstrap.sessionToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      )
      if (!response.ok) throw new Error(t("resultShareCreateFailed"))
      const created = (await response.json()) as PortalResultShare
      if (!created.code || !safeResultShareUrl(created.url)) {
        throw new Error(t("resultShareCreateFailed"))
      }
      setResultShare(created)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setResultShareBusy(false)
    }
  }

  const revokeResultShare = async () => {
    if (!bootstrap || !resultShare) return
    setResultShareBusy(true)
    setError(null)
    try {
      const response = await portalFetch(
        `${apiBase}/api/apps/${encodeURIComponent(portalAppSlug)}/result-shares/${encodeURIComponent(resultShare.code)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${bootstrap.sessionToken}` },
        }
      )
      if (!response.ok) throw new Error(t("resultShareRevokeFailed"))
      setResultShare(undefined)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setResultShareBusy(false)
    }
  }

  if (loading) return <main className="grid min-h-dvh place-items-center p-6">{t("loading")}</main>
  if (error && !bootstrap) {
    return <main className="grid min-h-dvh place-items-center p-6 text-destructive">{error}</main>
  }
  if (!bootstrap || !content) return null
  const color = /^#[0-9a-f]{6}$/i.test(bootstrap.app.theme.primaryColor)
    ? bootstrap.app.theme.primaryColor
    : "#4f46e5"
  const resultShareUrl = resultShare ? safeResultShareUrl(resultShare.url) : undefined

  return (
    <main
      className="min-h-dvh bg-muted/30 p-4 sm:p-8"
      style={{ "--portal-primary": color } as React.CSSProperties}
    >
      <div className="mx-auto max-w-2xl space-y-5 rounded-xl border bg-background p-5 shadow-sm">
        {bootstrap.app.blocks.map((block) => {
          if (block.type === "header") {
            return (
              <header key={block.id} className="space-y-2">
                {bootstrap.app.theme.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- runtime custom-domain asset is not known at export time.
                  <img
                    src={bootstrap.app.theme.logoUrl}
                    alt=""
                    className="h-10 max-w-48 object-contain"
                  />
                ) : null}
                <h1 className="text-2xl font-semibold">{content.title}</h1>
                {block.showDescription && content.description ? (
                  <p className="text-muted-foreground">{content.description}</p>
                ) : null}
              </header>
            )
          }
          if (block.type === "input-form" && bootstrap.app.kind === "workflow") {
            return (
              <section key={block.id} className="space-y-4">
                {Object.entries(bootstrap.app.inputSchema?.properties ?? {}).map(
                  ([key, property]) => (
                    <div key={key} className="space-y-1.5">
                      <Label htmlFor={`portal-${key}`}>
                        {property.title ?? key}
                        {required.has(key) ? ` ${t("requiredMark")}` : ""}
                      </Label>
                      {property.type === "boolean" ? (
                        <Checkbox
                          id={`portal-${key}`}
                          checked={Boolean(values[key])}
                          onCheckedChange={(checked) =>
                            setValues((current) => ({ ...current, [key]: checked === true }))
                          }
                        />
                      ) : property.format === "textarea" ? (
                        <Textarea
                          id={`portal-${key}`}
                          value={String(values[key] ?? "")}
                          onChange={(event) =>
                            setValues((current) => ({ ...current, [key]: event.target.value }))
                          }
                        />
                      ) : (
                        <Input
                          id={`portal-${key}`}
                          type={
                            property.type === "number" || property.type === "integer"
                              ? "number"
                              : "text"
                          }
                          value={String(values[key] ?? "")}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [key]:
                                property.type === "number" || property.type === "integer"
                                  ? Number(event.target.value)
                                  : event.target.value,
                            }))
                          }
                        />
                      )}
                      {property.description ? (
                        <p className="text-xs text-muted-foreground">{property.description}</p>
                      ) : null}
                    </div>
                  )
                )}
                <Button
                  onClick={() =>
                    void runWorkflow().catch((caught) =>
                      setError(caught instanceof Error ? caught.message : String(caught))
                    )
                  }
                  disabled={missingRequired || legalBlocked}
                  style={{ backgroundColor: color }}
                >
                  {block.submitLabel ?? content.inputSubmitLabel ?? t("run")}
                </Button>
                <div className="space-y-2 rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="max-w-sm"
                      type="file"
                      accept=".csv,text/csv"
                      aria-label={t("batchFile")}
                      onChange={(event) => setBatchFile(event.target.files?.[0])}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void downloadBatchTemplate().catch((caught) =>
                          setError(caught instanceof Error ? caught.message : String(caught))
                        )
                      }
                      disabled={batchBusy}
                    >
                      {t("batchTemplate")}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() =>
                        void startBatch().catch((caught) =>
                          setError(caught instanceof Error ? caught.message : String(caught))
                        )
                      }
                      disabled={!batchFile || batchBusy || legalBlocked}
                    >
                      {t("batchStart")}
                    </Button>
                  </div>
                  {batchJob ? (
                    <div className="space-y-2 text-sm" aria-live="polite">
                      <p>
                        {t("batchStatus", {
                          status: batchJob.status,
                          succeeded: batchJob.succeededRows,
                          failed: batchJob.failedRows,
                          waiting: batchJob.waitingRows,
                          total: batchJob.totalRows,
                        })}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {batchJob.status === "running" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={batchBusy}
                            onClick={() => void batchAction("pause")}
                          >
                            {t("batchPause")}
                          </Button>
                        ) : null}
                        {batchJob.status === "paused" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={batchBusy}
                            onClick={() => void batchAction("resume")}
                          >
                            {t("batchResume")}
                          </Button>
                        ) : null}
                        {!["completed", "cancelled", "failed"].includes(batchJob.status) ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={batchBusy}
                            onClick={() => void batchAction("cancel")}
                          >
                            {t("batchCancel")}
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={batchBusy}
                          onClick={() =>
                            void exportBatch().catch((caught) =>
                              setError(caught instanceof Error ? caught.message : String(caught))
                            )
                          }
                        >
                          {t("batchExport")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </section>
            )
          }
          if (block.type === "chat" && bootstrap.app.kind === "chatflow") {
            return (
              <section key={block.id} className="space-y-3">
                {content.welcomeMessage ? (
                  <p className="rounded-lg bg-muted p-3">{content.welcomeMessage}</p>
                ) : null}
                <div className="space-y-2" aria-live="polite">
                  {messages.map((message) => (
                    <p
                      key={message.id}
                      className={
                        message.role === "user"
                          ? "ml-8 rounded-lg bg-primary/10 p-3"
                          : "mr-8 rounded-lg bg-muted p-3"
                      }
                    >
                      {message.text}
                    </p>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    aria-label={t("message")}
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) void sendMessage()
                    }}
                  />
                  <Button
                    onClick={() => void sendMessage()}
                    disabled={!chatInput.trim() || legalBlocked}
                  >
                    {t("send")}
                  </Button>
                </div>
              </section>
            )
          }
          if (block.type === "result" && result !== undefined) {
            return (
              <section key={block.id} className="rounded-lg bg-muted p-3">
                <pre className="overflow-auto whitespace-pre-wrap text-sm">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </section>
            )
          }
          if (block.type === "footer") {
            return (
              <footer key={block.id} className="text-xs text-muted-foreground">
                {block.text}
              </footer>
            )
          }
          return null
        })}
        {feedbackTarget ? (
          <section className="space-y-3 rounded-lg border p-4" aria-live="polite">
            <h2 className="font-medium">{t("feedbackTitle")}</h2>
            {feedbackSubmitted ? (
              <p className="text-sm text-muted-foreground">{t("feedbackThanks")}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={feedbackRating === "like" ? "default" : "outline"}
                    disabled={feedbackBusy}
                    onClick={() => setFeedbackRating("like")}
                  >
                    {t("feedbackLike")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={feedbackRating === "dislike" ? "destructive" : "outline"}
                    disabled={feedbackBusy}
                    onClick={() => setFeedbackRating("dislike")}
                  >
                    {t("feedbackDislike")}
                  </Button>
                </div>
                {feedbackRating ? (
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="portal-feedback-tags">{t("feedbackTags")}</Label>
                      <Input
                        id="portal-feedback-tags"
                        value={feedbackTags}
                        placeholder={t("feedbackTagsPlaceholder")}
                        onChange={(event) => setFeedbackTags(event.target.value)}
                      />
                    </div>
                    {feedbackRating === "dislike" ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="portal-feedback-correction">
                          {t("feedbackCorrection")}
                        </Label>
                        <Textarea
                          id="portal-feedback-correction"
                          value={feedbackCorrection}
                          onChange={(event) => setFeedbackCorrection(event.target.value)}
                        />
                      </div>
                    ) : null}
                    <Button
                      type="button"
                      size="sm"
                      disabled={feedbackBusy}
                      onClick={() => void submitFeedback()}
                    >
                      {t("feedbackSubmit")}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </section>
        ) : null}
        {bootstrap.app.resultSharing?.enabled && feedbackTarget?.runId ? (
          <section className="space-y-3 rounded-lg border p-4" aria-live="polite">
            <h2 className="font-medium">{t("resultShareTitle")}</h2>
            {resultShare && resultShareUrl ? (
              <div className="space-y-2">
                <a
                  className="block break-all text-sm text-primary underline underline-offset-4"
                  href={resultShareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {resultShareUrl}
                </a>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={resultShareBusy}
                  onClick={() => void revokeResultShare()}
                >
                  {t("resultShareRevoke")}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={resultShareBusy}
                onClick={() => void createResultShare()}
              >
                {t("resultShareCreate")}
              </Button>
            )}
          </section>
        ) : null}
        {humanInputRequests.length ? (
          <section className="space-y-4" aria-live="polite">
            <h2 className="text-lg font-semibold">{t("humanInputInbox")}</h2>
            {humanInputRequests.map((request) => {
              const requestValues = humanInputValues[request.id] ?? {}
              const submitBusy = humanInputBusy.has(`${request.id}:submit`)
              const missingRequiredField = request.fields.some(
                (field) => field.required && isMissingHumanInputValue(requestValues[field.id])
              )
              return (
                <form
                  key={request.id}
                  className="space-y-4 rounded-lg border p-4"
                  onSubmit={(event) => event.preventDefault()}
                >
                  <div className="space-y-1">
                    <h3 className="font-medium">{request.title}</h3>
                    {request.message ? (
                      <p className="text-sm text-muted-foreground">{request.message}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {t("humanInputResponses", { count: request.submittedCount })}
                    </p>
                  </div>
                  {request.fields.map((field) => {
                    const inputId = `human-input-${request.id}-${field.id}`
                    const value = requestValues[field.id]
                    const fieldBusy = humanInputBusy.has(`${request.id}:${field.id}`)
                    return (
                      <fieldset key={field.id} className="space-y-1.5" disabled={submitBusy}>
                        <Label htmlFor={inputId}>
                          {field.label}
                          {field.required ? ` ${t("requiredMark")}` : ""}
                        </Label>
                        {field.type === "long-text" ? (
                          <Textarea
                            id={inputId}
                            value={typeof value === "string" ? value : ""}
                            onChange={(event) =>
                              setHumanInputValue(request.id, field.id, event.target.value)
                            }
                          />
                        ) : field.type === "number" ? (
                          <Input
                            id={inputId}
                            type="number"
                            min={field.min}
                            max={field.max}
                            value={typeof value === "number" ? value : ""}
                            onChange={(event) =>
                              setHumanInputValue(
                                request.id,
                                field.id,
                                event.target.value === "" ? null : Number(event.target.value)
                              )
                            }
                          />
                        ) : field.type === "boolean" ? (
                          <Checkbox
                            id={inputId}
                            checked={value === true}
                            onCheckedChange={(checked) =>
                              setHumanInputValue(request.id, field.id, checked === true)
                            }
                          />
                        ) : field.type === "single-select" ? (
                          <select
                            id={inputId}
                            className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
                            value={typeof value === "string" ? value : ""}
                            onChange={(event) =>
                              setHumanInputValue(request.id, field.id, event.target.value)
                            }
                          >
                            <option value="">{t("humanInputSelect")}</option>
                            {field.options?.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : field.type === "multi-select" ? (
                          <div className="space-y-2">
                            {field.options?.map((option) => {
                              const selected = Array.isArray(value) ? value : []
                              const optionId = `${inputId}-${option.value}`
                              return (
                                <div key={option.value} className="flex items-center gap-2">
                                  <Checkbox
                                    id={optionId}
                                    checked={selected.includes(option.value)}
                                    onCheckedChange={(checked) =>
                                      setHumanInputValue(
                                        request.id,
                                        field.id,
                                        checked === true
                                          ? [...selected, option.value]
                                          : selected.filter((item) => item !== option.value)
                                      )
                                    }
                                  />
                                  <Label htmlFor={optionId}>{option.label}</Label>
                                </div>
                              )
                            })}
                          </div>
                        ) : field.type === "file" || field.type === "file-list" ? (
                          <div className="space-y-1">
                            <Input
                              id={inputId}
                              type="file"
                              accept={field.accept?.join(",")}
                              multiple={field.type === "file-list"}
                              disabled={fieldBusy}
                              onChange={(event) =>
                                void uploadHumanInputFiles(request, field, event.target.files)
                              }
                            />
                            {value ? (
                              <p className="text-xs text-muted-foreground">
                                {t("humanInputFilesUploaded", {
                                  count: Array.isArray(value) ? value.length : 1,
                                })}
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <Input
                            id={inputId}
                            value={typeof value === "string" ? value : ""}
                            onChange={(event) =>
                              setHumanInputValue(request.id, field.id, event.target.value)
                            }
                          />
                        )}
                        {field.description ? (
                          <p className="text-xs text-muted-foreground">{field.description}</p>
                        ) : null}
                      </fieldset>
                    )
                  })}
                  <div className="flex flex-wrap gap-2">
                    {request.actions.map((action) => (
                      <Button
                        key={action.id}
                        type="button"
                        variant={
                          action.tone === "destructive"
                            ? "destructive"
                            : action.tone === "secondary"
                              ? "outline"
                              : "default"
                        }
                        disabled={submitBusy || missingRequiredField}
                        onClick={() => void submitHumanInputRequest(request, action.id)}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                </form>
              )
            })}
          </section>
        ) : null}
        {bootstrap.app.legal.requireConsent ? (
          <div className="flex items-start gap-2 text-sm">
            <Checkbox
              id="portal-consent"
              checked={consented}
              onCheckedChange={(value) => setConsented(value === true)}
            />
            <Label htmlFor="portal-consent">{content.legalConsentLabel ?? t("legalConsent")}</Label>
          </div>
        ) : null}
        {bootstrap.recoveryKey ? (
          <p className="rounded border p-2 text-xs">
            {t("recoveryKey", { key: bootstrap.recoveryKey })}
          </p>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </main>
  )
}
