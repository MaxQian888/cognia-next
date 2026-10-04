"use client"

import { useEffect, useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { pickStreamFiles } from "@/lib/files/file-bridge"
import { saveExport } from "@/lib/files/save-export"
import { decodeBase64, encodeBase64 } from "@/lib/share/encoding"
import { MAX_SANDBOX_TRANSFER_BYTES, sandboxClient } from "@/lib/automation/sandbox-client"

type Notice =
  | "cancelled"
  | "uploaded"
  | "downloaded"
  | "tooLarge"
  | "readFailed"
  | "saveFailed"
  | "uploadFailed"
  | "downloadFailed"
  | "invalidPath"
  | "invalidPayload"
  | null

function absolutePath(value: string): boolean {
  return value.startsWith("/") && !value.includes("\0") && !value.split("/").includes("..")
}

interface SandboxFileTransferProps {
  connectionId: string
  containerId?: string
  enabled: boolean
  releaseControl: () => Promise<void> | undefined
  onBusyChange: (busy: boolean) => void
}

/** A bounded single-file transfer, scoped to the container selected before any native dialog. */
export function SandboxFileTransfer(props: SandboxFileTransferProps) {
  return (
    <SandboxFileTransferSession
      key={`${props.connectionId}:${props.containerId ?? ""}:${props.enabled}`}
      {...props}
    />
  )
}

function SandboxFileTransferSession({
  connectionId,
  containerId,
  enabled,
  releaseControl,
  onBusyChange,
}: SandboxFileTransferProps) {
  const t = useTranslations("automation.sandboxConnections.fileTransfer")
  const id = useId()
  const [folder, setFolder] = useState("/home/cua")
  const [downloadPath, setDownloadPath] = useState("")
  const [busy, setBusy] = useState<"upload" | "download" | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const lifetime = useRef({ current: true, busy: false })

  useEffect(() => {
    const generation = { current: true, busy: false }
    lifetime.current = generation
    return () => {
      generation.current = false
      onBusyChange(false)
    }
  }, [connectionId, containerId, enabled, onBusyChange])

  async function transfer(kind: "upload" | "download") {
    const generation = lifetime.current
    if (!enabled || !containerId || generation.busy) return
    const path = kind === "upload" ? folder.trim() : downloadPath.trim()
    if (!absolutePath(path) || (kind === "download" && path.endsWith("/"))) {
      setNotice("invalidPath")
      return
    }
    generation.busy = true
    setBusy(kind)
    setNotice(null)
    onBusyChange(true)
    let token: string | undefined
    let failure: Notice = kind === "upload" ? "readFailed" : "downloadFailed"
    try {
      if (kind === "upload") {
        const files = await pickStreamFiles({ multiple: false })
        if (!generation.current) return
        const file = files[0]
        if (!file) {
          setNotice("cancelled")
          return
        }
        if (!file.name || /[\\/\0]/.test(file.name) || file.name === "." || file.name === "..") {
          setNotice("invalidPath")
          return
        }
        const chunks: Uint8Array[] = []
        let length = 0
        // Breaking/returning from for-await closes the shared picker stream,
        // including its native file descriptor on oversize or target change.
        for await (const chunk of file.stream()) {
          if (!generation.current) return
          length += chunk.byteLength
          if (length > MAX_SANDBOX_TRANSFER_BYTES) {
            setNotice("tooLarge")
            return
          }
          chunks.push(chunk)
        }
        if (!generation.current) return
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        // Multiples of three preserve base64 padding across chunk boundaries
        // without the encoder building an eight-million-character rope.
        const encodedChunks: string[] = []
        for (let start = 0; start < bytes.length; start += 48 * 1024) {
          encodedChunks.push(encodeBase64(bytes.subarray(start, start + 48 * 1024)))
        }
        const encoded = encodedChunks.join("")
        failure = "uploadFailed"
        await releaseControl()
        if (!generation.current) return
        const lease = await sandboxClient.acquireControl(connectionId)
        token = lease.token
        if (!generation.current) return
        await sandboxClient.uploadFile(
          connectionId,
          containerId,
          token,
          `${path.replace(/\/+$/, "")}/${file.name}`,
          encoded
        )
        if (generation.current) setNotice("uploaded")
      } else {
        const result = await sandboxClient.downloadFile(connectionId, containerId, path)
        if (!generation.current) return
        // Bound allocation before decoding a response crossing the IPC boundary.
        if (
          !Number.isSafeInteger(result.size) ||
          result.size < 0 ||
          result.size > MAX_SANDBOX_TRANSFER_BYTES ||
          result.dataBase64.length > Math.ceil(MAX_SANDBOX_TRANSFER_BYTES / 3) * 4
        ) {
          setNotice("tooLarge")
          return
        }
        failure = "invalidPayload"
        const bytes = decodeBase64(result.dataBase64)
        if (bytes.byteLength !== result.size) {
          setNotice("invalidPayload")
          return
        }
        const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
        if (!generation.current) return
        const hash = Array.from(new Uint8Array(digest), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")
        if (hash !== result.sha256.toLowerCase()) {
          setNotice("invalidPayload")
          return
        }
        failure = "saveFailed"
        const outcome = await saveExport({
          filename: path.split("/").pop()!,
          data: bytes,
          mimeType: "application/octet-stream",
          shouldContinue: () => generation.current,
        })
        if (!generation.current) return
        setNotice(
          outcome.kind === "saved"
            ? "downloaded"
            : outcome.kind === "cancelled"
              ? "cancelled"
              : "saveFailed"
        )
      }
    } catch {
      if (generation.current) setNotice(failure)
    } finally {
      // A dispatched upload may finish after unmount. Release its exact lease,
      // even though no UI is left to receive the result. Expiry is already safe.
      if (token) await sandboxClient.releaseControl(connectionId, token).catch(() => undefined)
      generation.busy = false
      if (generation.current) {
        setBusy(null)
        onBusyChange(false)
      }
    }
  }

  const disabled = !enabled || !containerId || busy !== null
  const isError = notice !== null && !["cancelled", "uploaded", "downloaded"].includes(notice)
  return (
    <section className="space-y-3" aria-label={t("title")}>
      <h3 className="text-sm font-medium">{t("title")}</h3>
      <p className="text-xs text-muted-foreground">
        {t("help", { limit: MAX_SANDBOX_TRANSFER_BYTES / 1024 / 1024 })}
      </p>
      {!containerId ? (
        <p className="text-xs text-muted-foreground">{t("missingContainer")}</p>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor={`${id}-folder`}>{t("folder")}</Label>
        <Input
          id={`${id}-folder`}
          value={folder}
          disabled={disabled}
          onChange={(event) => setFolder(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => void transfer("upload")}
        >
          {busy === "upload" ? t("uploading") : t("upload")}
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor={`${id}-download`}>{t("downloadPath")}</Label>
        <Input
          id={`${id}-download`}
          value={downloadPath}
          disabled={disabled}
          onChange={(event) => setDownloadPath(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || !downloadPath.trim()}
          onClick={() => void transfer("download")}
        >
          {busy === "download" ? t("downloading") : t("download")}
        </Button>
      </div>
      {notice ? (
        <p
          role={isError ? "alert" : "status"}
          className={`text-xs ${isError ? "text-destructive" : "text-muted-foreground"}`}
        >
          {t(`notice.${notice}`)}
        </p>
      ) : null}
    </section>
  )
}
