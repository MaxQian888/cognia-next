"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { getPluginDevServer, type DevConsoleMessage, type DevServerStatus } from "./dev-server"

export function usePluginDevServer() {
  const devServer = useMemo(() => getPluginDevServer(), [])
  const [status, setStatus] = useState<DevServerStatus>(() => devServer.getStatus())
  const [consoleLogs, setConsoleLogs] = useState<DevConsoleMessage[]>([])

  useEffect(() => {
    const unsubscribeConsole = devServer.onConsoleLog((log) => {
      setConsoleLogs((prev) => [...prev.slice(-99), log])
    })

    const unsubscribeMessage = devServer.onMessage(() => {
      setStatus(devServer.getStatus())
    })

    return () => {
      unsubscribeConsole()
      unsubscribeMessage()
    }
  }, [devServer])

  const start = useCallback(async () => {
    await devServer.start()
    setStatus(devServer.getStatus())
  }, [devServer])

  const stop = useCallback(async () => {
    await devServer.stop()
    setStatus(devServer.getStatus())
  }, [devServer])

  const build = useCallback(
    async (pluginId: string) => {
      return devServer.buildPlugin(pluginId)
    },
    [devServer]
  )

  const clearLogs = useCallback(
    (pluginId?: string) => {
      devServer.clearConsoleLogs(pluginId)
      setConsoleLogs(devServer.getConsoleLogs())
    },
    [devServer]
  )

  return {
    status,
    consoleLogs,
    start,
    stop,
    build,
    clearLogs,
    devServer,
  }
}
