"use client"

import { useEffect, useState } from "react"

export function ReadingProgress() {
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    function compute() {
      const doc = document.documentElement
      const scrollTop = window.scrollY
      const max = doc.scrollHeight - window.innerHeight
      if (max <= 0) {
        setProgress(0)
        return
      }
      const pct = Math.min(100, Math.max(0, (scrollTop / max) * 100))
      setProgress(pct)
    }

    compute()
    window.addEventListener("scroll", compute, { passive: true })
    window.addEventListener("resize", compute)
    return () => {
      window.removeEventListener("scroll", compute)
      window.removeEventListener("resize", compute)
    }
  }, [])

  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-x-0 top-0 z-50 h-[2px]">
      <div
        className="h-full bg-gradient-to-r from-fuchsia-500 via-violet-500 to-sky-500 transition-[width] duration-150 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  )
}
