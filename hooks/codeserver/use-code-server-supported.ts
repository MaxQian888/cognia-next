"use client"

import { useEffect, useState } from "react"
import { createLogger } from "@cognia/logging"

import { codeServerClient } from "@/lib/codeserver/client"

export type CodeServerSupportStatus = "checking" | "supported" | "unsupported" | "error"

const log = createLogger("codeserver.support")

/** Probe embedded code-server support without conflating IPC failure with unsupported hardware. */
export function useCodeServerSupported(enabled: boolean): CodeServerSupportStatus {
  const [status, setStatus] = useState<CodeServerSupportStatus>("checking")

  useEffect(() => {
    if (!enabled) return

    let active = true
    queueMicrotask(() => {
      if (active) setStatus("checking")
    })
    void codeServerClient
      .supported()
      .then((supported) => {
        if (active) setStatus(supported ? "supported" : "unsupported")
      })
      .catch((error: unknown) => {
        log.warn("code-server support probe failed", { error: String(error) })
        if (active) setStatus("error")
      })

    return () => {
      active = false
    }
  }, [enabled])

  return enabled ? status : "unsupported"
}
