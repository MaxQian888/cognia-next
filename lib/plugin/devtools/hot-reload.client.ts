"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { getPluginHotReload, type ReloadResult } from "./hot-reload"

export function usePluginHotReload() {
  const hotReload = useMemo(() => getPluginHotReload(), [])
  const [isWatching, setIsWatching] = useState(() => hotReload.isWatching())
  const [reloadHistory, setReloadHistory] = useState<ReloadResult[]>(() =>
    hotReload.getReloadHistory()
  )

  useEffect(() => {
    const unsubscribeReload = hotReload.onReload((result) => {
      setReloadHistory((prev) => [...prev.slice(-49), result])
      setIsWatching(hotReload.isWatching())
    })

    return () => {
      unsubscribeReload()
    }
  }, [hotReload])

  const reloadPlugin = useCallback(
    async (pluginId: string) => {
      return hotReload.reloadPlugin(pluginId)
    },
    [hotReload]
  )

  const reloadAll = useCallback(async () => {
    return hotReload.reloadAll()
  }, [hotReload])

  return {
    isWatching,
    reloadHistory,
    reloadPlugin,
    reloadAll,
    hotReload,
  }
}
