"use client"

import { useEffect } from "react"

import { interruptRendererBackgroundTasksOnBoot } from "@/lib/background-tasks/renderer-subagent-registry"

export function BackgroundTaskInitializer() {
  useEffect(() => {
    void interruptRendererBackgroundTasksOnBoot()
  }, [])

  return null
}
