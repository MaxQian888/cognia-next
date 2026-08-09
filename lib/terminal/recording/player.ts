/**
 * Terminal recording player.
 *
 * Takes a `TerminalRecording` and replays the frames at their original
 * timing (or scaled by a speed multiplier). Emits frame data via a
 * callback so the consumer can write it to a terminal surface.
 *
 * Supports: play, pause, seek, speed adjustment.
 */

import type { PlaybackState, TerminalRecording } from "./types"

/** Callback fired when a frame should be rendered. */
export type FrameEmitter = (data: string, time: number) => void

/** Callback fired when playback state changes. */
export type PlaybackStateCallback = (state: PlaybackState) => void

export interface Player {
  /** Current playback state. */
  readonly state: PlaybackState
  /** Start or resume playback. */
  play(): void
  /** Pause playback. */
  pause(): void
  /** Seek to a position (seconds). Emits all frames up to that point. */
  seek(position: number): void
  /** Set playback speed (1 = realtime, 2 = double speed). */
  setSpeed(speed: number): void
  /** Stop and release resources. */
  dispose(): void
  /** Register a state change listener. Returns unsubscribe. */
  onStateChange(cb: PlaybackStateCallback): () => void
}

export interface PlayerDeps {
  /** Frame emitter — called with the frame data to render. */
  onFrame: FrameEmitter
  /** Clock function. Defaults to `Date.now`. */
  now?: () => number
  /** Timer function. Defaults to `setTimeout`. */
  scheduleTimer?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  /** Cancel timer. Defaults to `clearTimeout`. */
  cancelTimer?: (id: ReturnType<typeof setTimeout>) => void
}

export function createPlayer(recording: TerminalRecording, deps: PlayerDeps): Player {
  const { onFrame } = deps
  const clock = deps.now ?? Date.now
  const schedule = deps.scheduleTimer ?? setTimeout
  const cancelSchedule = deps.cancelTimer ?? clearTimeout

  const frames = recording.frames
  const duration = recording.duration

  let playing = false
  let speed = 1
  let position = 0
  let frameIndex = 0
  let playStartTime = 0
  let playStartPosition = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<PlaybackStateCallback>()

  function getState(): PlaybackState {
    return { position, playing, speed, duration }
  }

  function notify() {
    const state = getState()
    for (const cb of listeners) cb(state)
  }

  function cancelPending() {
    if (timer !== null) {
      cancelSchedule(timer)
      timer = null
    }
  }

  /** Emit all frames from frameIndex up to (but not past) targetTime. */
  function emitFramesUpTo(targetTime: number) {
    while (frameIndex < frames.length && frames[frameIndex][0] <= targetTime) {
      const frame = frames[frameIndex]
      onFrame(frame[2], frame[0])
      frameIndex++
    }
    position = Math.min(targetTime, duration)
  }

  /** Schedule the next frame to fire at the correct wall-clock time. */
  function scheduleNextFrame() {
    if (!playing || frameIndex >= frames.length) {
      // Playback complete
      if (frameIndex >= frames.length) {
        playing = false
        position = duration
        notify()
      }
      return
    }

    const nextFrameTime = frames[frameIndex][0]
    const elapsedReal = (clock() - playStartTime) / 1000
    const elapsedVirtual = playStartPosition + elapsedReal * speed
    const delayMs = ((nextFrameTime - elapsedVirtual) / speed) * 1000

    if (delayMs <= 0) {
      // Frame should have already been emitted
      emitFramesUpTo(nextFrameTime)
      notify()
      scheduleNextFrame()
    } else {
      timer = schedule(
        () => {
          if (!playing) return
          emitFramesUpTo(nextFrameTime)
          notify()
          scheduleNextFrame()
        },
        Math.max(1, delayMs)
      )
    }
  }

  const player: Player = {
    get state() {
      return getState()
    },

    play() {
      if (playing) return
      if (position >= duration) {
        // Restart from beginning
        position = 0
        frameIndex = 0
      }
      playing = true
      playStartTime = clock()
      playStartPosition = position
      notify()
      scheduleNextFrame()
    },

    pause() {
      if (!playing) return
      cancelPending()
      // Update position to current
      const elapsedReal = (clock() - playStartTime) / 1000
      position = Math.min(playStartPosition + elapsedReal * speed, duration)
      playing = false
      notify()
    },

    seek(targetPosition: number) {
      cancelPending()
      const clamped = Math.max(0, Math.min(targetPosition, duration))

      // Reset frame index to find the right position
      if (clamped < position) {
        frameIndex = 0
      }

      // Emit all frames up to the target position
      emitFramesUpTo(clamped)
      position = clamped

      if (playing) {
        playStartTime = clock()
        playStartPosition = position
        scheduleNextFrame()
      }
      notify()
    },

    setSpeed(newSpeed: number) {
      if (newSpeed <= 0) return
      const wasPlaying = playing
      if (wasPlaying) {
        player.pause()
      }
      speed = newSpeed
      if (wasPlaying) {
        player.play()
      } else {
        notify()
      }
    },

    dispose() {
      cancelPending()
      playing = false
      listeners.clear()
    },

    onStateChange(cb: PlaybackStateCallback) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
  }

  return player
}
