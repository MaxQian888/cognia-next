"use client"

import { useEffect, useMemo, useSyncExternalStore } from "react"

import {
  TranscriptController,
  type TranscriptControllerSnapshot,
} from "@/lib/chat/transcript/controller"
import type { TranscriptSource } from "@/lib/chat/transcript/source"

const EMPTY_SNAPSHOT: TranscriptControllerSnapshot = {
  mode: "unknown",
  items: [],
  revision: null,
  loading: false,
  loadingOlder: false,
  hasMore: false,
  expandedTurnKeys: new Set(),
  error: null,
}

export interface UseTranscriptControllerResult {
  snapshot: TranscriptControllerSnapshot
  getDetail: TranscriptController["getDetail"]
  loadOlder: TranscriptController["loadOlder"]
  expandTurn: TranscriptController["expandTurn"]
  collapseTurn: TranscriptController["collapseTurn"]
  retry: TranscriptController["loadInitial"]
}

export function useTranscriptController(
  sessionId: string | null,
  source: TranscriptSource
): UseTranscriptControllerResult {
  const controller = useMemo(
    () => (sessionId ? new TranscriptController(sessionId, source) : null),
    [sessionId, source]
  )
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? (() => () => {}),
    controller?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
    () => EMPTY_SNAPSHOT
  )

  useEffect(() => {
    if (!controller) return
    // `start()` opens the revision subscription — a side effect that must not
    // run while the owning component renders (see TranscriptController.start).
    controller.start()
    void controller.loadInitial()
    return () => controller.clear()
  }, [controller])

  return {
    snapshot,
    getDetail: controller?.getDetail.bind(controller) ?? (() => undefined),
    loadOlder: controller?.loadOlder.bind(controller) ?? (async () => {}),
    expandTurn: controller?.expandTurn.bind(controller) ?? (async () => {}),
    collapseTurn: controller?.collapseTurn.bind(controller) ?? (() => {}),
    retry: controller?.loadInitial.bind(controller) ?? (async () => {}),
  }
}
