"use client"

import { memo, useEffect, useRef } from "react"
import { cn } from "@/lib/utils"

interface CanvasSimulationRichOutputProps {
  config?: Record<string, unknown> | null
  height?: number
  className?: string
}

export const CanvasSimulationRichOutput = memo(function CanvasSimulationRichOutput({
  config,
  height = 260,
  className,
}: CanvasSimulationRichOutputProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas?.getContext("2d")
    if (!canvas || !context) {
      return
    }

    const amplitude = Number(config?.amplitude ?? 24)
    const frequency = Number(config?.frequency ?? 2)
    let frame = 0
    let rafId = 0

    const renderFrame = () => {
      frame += 1
      const { width, height: canvasHeight } = canvas
      context.clearRect(0, 0, width, canvasHeight)
      context.fillStyle = "rgba(15, 23, 42, 0.04)"
      context.fillRect(0, 0, width, canvasHeight)

      context.beginPath()
      context.lineWidth = 3
      context.strokeStyle = "#0ea5e9"
      for (let x = 0; x <= width; x += 4) {
        const wave = Math.sin((x / width) * Math.PI * frequency + frame * 0.06)
        const y = canvasHeight / 2 + wave * amplitude
        if (x === 0) {
          context.moveTo(x, y)
        } else {
          context.lineTo(x, y)
        }
      }
      context.stroke()

      rafId = window.requestAnimationFrame(renderFrame)
    }

    rafId = window.requestAnimationFrame(renderFrame)
    return () => window.cancelAnimationFrame(rafId)
  }, [config])

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-border/60 bg-background/70 p-3",
        className
      )}
    >
      <canvas ref={canvasRef} width={640} height={height} className="h-full w-full rounded-md" />
    </div>
  )
})
