/**
 * A2UI App Builder - Share Functions
 * Handles share codes, URLs, clipboard, native sharing, and social share URLs
 */

import { useCallback } from "react"
import { loggers } from "@/lib/logging"
import type { A2UIAppInstance } from "./types"

const log = loggers.app

interface ShareDeps {
  exportApp: (appId: string) => string | null
  getAppInstance: (appId: string) => A2UIAppInstance | undefined
}

export function useAppShare(deps: ShareDeps) {
  const { exportApp, getAppInstance } = deps

  const generateShareCode = useCallback(
    (appId: string): string | null => {
      const jsonData = exportApp(appId)
      if (!jsonData) return null

      try {
        const compressed = JSON.stringify(JSON.parse(jsonData))
        const base64 = btoa(encodeURIComponent(compressed))
        return base64
      } catch (error) {
        log.error("A2UI AppBuilder: Share code generation failed", error as Error)
        return null
      }
    },
    [exportApp]
  )

  const importFromShareCode = useCallback(
    (shareCode: string, importApp: (json: string) => string | null): string | null => {
      try {
        const decoded = decodeURIComponent(atob(shareCode))
        return importApp(decoded)
      } catch (error) {
        log.error("A2UI AppBuilder: Share code import failed", error as Error)
        return null
      }
    },
    []
  )

  const generateShareUrl = useCallback(
    (appId: string, baseUrl?: string): string | null => {
      const shareCode = generateShareCode(appId)
      if (!shareCode) return null

      const base = baseUrl || (typeof window !== "undefined" ? window.location.origin : "")
      return `${base}/share/app?code=${encodeURIComponent(shareCode)}`
    },
    [generateShareCode]
  )

  const copyAppToClipboard = useCallback(
    async (appId: string, format: "json" | "code" | "url" = "code"): Promise<boolean> => {
      let content: string | null = null

      switch (format) {
        case "json":
          content = exportApp(appId)
          break
        case "code":
          content = generateShareCode(appId)
          break
        case "url":
          content = generateShareUrl(appId)
          break
      }

      if (!content) return false

      try {
        await navigator.clipboard.writeText(content)
        return true
      } catch (error) {
        log.error("A2UI AppBuilder: Clipboard write failed", error as Error)
        return false
      }
    },
    [exportApp, generateShareCode, generateShareUrl]
  )

  const getShareData = useCallback(
    (appId: string): { title: string; text: string; url: string } | null => {
      const instance = getAppInstance(appId)
      if (!instance) return null

      const shareUrl = generateShareUrl(appId)
      if (!shareUrl) return null

      return {
        title: instance.name,
        text: `Check out my "${instance.name}" app built with A2UI!`,
        url: shareUrl,
      }
    },
    [getAppInstance, generateShareUrl]
  )

  const shareAppNative = useCallback(
    async (appId: string): Promise<boolean> => {
      const shareData = getShareData(appId)
      if (!shareData) return false

      if (typeof navigator !== "undefined" && navigator.share) {
        try {
          await navigator.share(shareData)
          return true
        } catch (error) {
          if ((error as Error).name !== "AbortError") {
            log.error("A2UI AppBuilder: Native share failed", error as Error)
          }
          return false
        }
      }

      return copyAppToClipboard(appId, "url")
    },
    [getShareData, copyAppToClipboard]
  )

  const getSocialShareUrls = useCallback(
    (appId: string): Record<string, string> | null => {
      const shareData = getShareData(appId)
      if (!shareData) return null

      const encodedUrl = encodeURIComponent(shareData.url)
      const encodedTitle = encodeURIComponent(shareData.title)
      const encodedText = encodeURIComponent(shareData.text)

      return {
        twitter: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`,
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
        linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
        telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
        whatsapp: `https://wa.me/?text=${encodedText}%20${encodedUrl}`,
        email: `mailto:?subject=${encodedTitle}&body=${encodedText}%0A%0A${encodedUrl}`,
        wechat: shareData.url,
      }
    },
    [getShareData]
  )

  return {
    generateShareCode,
    importFromShareCode,
    generateShareUrl,
    copyAppToClipboard,
    getShareData,
    shareAppNative,
    getSocialShareUrls,
  }
}
