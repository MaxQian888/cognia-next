"use client"

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  subscribeCameraRecovery,
  type CameraRecoveryResult,
  type CameraRecoveryTarget,
} from "@/lib/capacitor/camera-recovery"

/** Subscribe only while the destination is ready; invalidate work when it leaves. */
export function useCameraRecovery(
  target: CameraRecoveryTarget | null,
  handler: (
    result: Exclude<CameraRecoveryResult, { kind: "error" }>,
    isCurrent: () => boolean
  ) => Promise<boolean>
): void {
  const t = useTranslations("mobile.composerPlus")
  const handlerRef = useRef(handler)
  const tRef = useRef(t)
  useEffect(() => {
    handlerRef.current = handler
    tRef.current = t
  }, [handler, t])
  const kind = target?.kind
  const id = target?.id
  useEffect(() => {
    if (!kind || !id) return
    let active = true
    const remove = subscribeCameraRecovery({ kind, id }, (result, isScopeCurrent) => {
      if (!active || !isScopeCurrent()) return Promise.resolve(false)
      if (result.kind === "error") {
        toast.error(tRef.current("photoFailed"))
        return Promise.resolve(true)
      }
      return handlerRef.current(result, () => active && isScopeCurrent())
    })
    return () => {
      active = false
      remove()
    }
  }, [kind, id])
}
