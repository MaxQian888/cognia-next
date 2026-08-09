"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"

import type { MissingMediaLoader } from "@/lib/chat/media/resolve-media"
import type { Transport } from "@/lib/tauri/transport-types"

const SessionMediaLoaderContext = createContext<MissingMediaLoader | undefined>(undefined)

export interface SessionMediaProviderProps {
  sessionId: string
  transport: Pick<Transport, "readBinary">
  children: ReactNode
}

/**
 * Build the authenticated, session-scoped missing-media loader used by remote
 * transcript surfaces. The canonical variant is cached because the existing
 * content-addressed store requires canonical bytes as its durable base row.
 */
export function createSessionMediaLoader(
  sessionId: string,
  transport: Pick<Transport, "readBinary">
): MissingMediaLoader | undefined {
  if (!transport.readBinary) return undefined
  return async ({ hash, variant }) => {
    const response = await transport.readBinary!({
      kind: "session-media",
      sessionId,
      hash,
      variant,
    })
    const bytes = Uint8Array.from(response.bytes)
    const now = Date.now()
    return {
      hash,
      mediaType: response.mediaType,
      width: 0,
      height: 0,
      blob: new Blob([bytes.buffer], { type: response.mediaType }),
      byteSize: bytes.byteLength,
      canonicalAvailable: variant === "canonical",
      ...(variant === "thumbnail"
        ? {
            thumbBlob: new Blob([bytes.buffer], { type: response.mediaType }),
            thumbWidth: 0,
            thumbHeight: 0,
          }
        : {}),
      createdAt: now,
      lastUsedAt: now,
    }
  }
}

export function SessionMediaProvider({
  sessionId,
  transport,
  children,
}: SessionMediaProviderProps) {
  const loader = useMemo(
    () => createSessionMediaLoader(sessionId, transport),
    [sessionId, transport]
  )
  return (
    <SessionMediaLoaderContext.Provider value={loader}>
      {children}
    </SessionMediaLoaderContext.Provider>
  )
}

export function useSessionMediaLoader(): MissingMediaLoader | undefined {
  return useContext(SessionMediaLoaderContext)
}
