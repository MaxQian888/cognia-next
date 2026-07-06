import { useCallback, useRef, useState } from "react"

const BACKTRACK_ARM_MS = 1500

/**
 * Double-Esc backtrack (Codex's "Esc twice to edit the last message"): the first
 * idle Esc arms a short window, the second pulls the last user message back into
 * the composer for editing — without touching the transcript (rewinding history
 * stays with /rewind, /retry). `armed` is mirrored to React state so BottomStatus
 * can show the confirm hint; the ref is the source of truth for the key handler.
 */
export function useBacktrack(): {
  backtrackArmed: boolean
  backtrackArmedRef: React.MutableRefObject<boolean>
  armBacktrack: () => void
  disarmBacktrack: () => void
} {
  const [backtrackArmed, setBacktrackArmed] = useState(false)
  const backtrackArmedRef = useRef(false)
  const backtrackTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const disarmBacktrack = useCallback(() => {
    backtrackArmedRef.current = false
    setBacktrackArmed(false)
    if (backtrackTimer.current) {
      clearTimeout(backtrackTimer.current)
      backtrackTimer.current = null
    }
  }, [])

  const armBacktrack = useCallback(() => {
    backtrackArmedRef.current = true
    setBacktrackArmed(true)
    if (backtrackTimer.current) clearTimeout(backtrackTimer.current)
    backtrackTimer.current = setTimeout(() => {
      backtrackArmedRef.current = false
      setBacktrackArmed(false)
      backtrackTimer.current = null
    }, BACKTRACK_ARM_MS)
  }, [])

  return { backtrackArmed, backtrackArmedRef, armBacktrack, disarmBacktrack }
}
