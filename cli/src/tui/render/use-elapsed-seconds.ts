/**
 * Seconds elapsed since a cell became active, for the live "running for Ns" hint
 * on an in-flight tool. Ticks once a second while `active`; resets to 0 when
 * inactive. Only meaningful in the live region (a committed/`<Static>` cell is
 * never `running`, so the hook is inert there).
 */
import { useEffect, useState } from "react"

export function useElapsedSeconds(active: boolean): number {
  const [secs, setSecs] = useState(0)

  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [active])

  return active ? secs : 0
}
