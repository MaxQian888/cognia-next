"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import type { PetSkin, PetSkinRenderProps } from "@/types/pet"
import { PET_SKIN_CAPABILITIES } from "@/lib/pet/skin-governance"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import { loadMediaSkinAsset } from "@/lib/pet/media-packs/asset-bridge"
import { mediaFrameAt, planMediaMotion, type MediaMotionPlan } from "@/lib/pet/media-packs/playback"
import type { MediaClip, MediaPackAsset } from "@/lib/pet/media-packs/manifest"
import { svgSkin } from "./svg-skin"

export function MediaCanvas({
  asset,
  clip,
  size,
  paused,
  reducedMotion,
  lowPower,
  cycle = 0,
  onEnded,
  onError,
}: {
  asset: MediaPackAsset
  clip: Exclude<MediaClip, { kind: "video" }>
  size: number
  paused?: boolean
  reducedMotion: boolean
  lowPower?: boolean
  cycle?: number
  onEnded(): void
  onError(): void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const endedRef = useRef(onEnded),
    errorRef = useRef(onError)
  const clock = useRef({ clip, cycle, elapsed: 0 })
  useEffect(() => {
    endedRef.current = onEnded
    errorRef.current = onError
  }, [onEnded, onError])
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext("2d")
    if (!context) {
      errorRef.current()
      return
    }
    const runtime = getPetSkinRuntime(),
      key = `media:${asset.id}`
    const files = new Map(asset.entries.map((entry) => [entry.path, entry.blob]))
    const images = new Map<string, HTMLImageElement>()
    if (clock.current.clip !== clip || clock.current.cycle !== cycle)
      clock.current = { clip, cycle, elapsed: 0 }
    let active = true,
      raf = 0,
      start: number | undefined,
      previousFrame = -1,
      paintedFrame = -1,
      lastPaint = -Infinity,
      snapshot = false
    const draw = (index: number) => {
      const path = clip.kind === "frames" ? clip.frames[index] : clip.file
      const blob = files.get(path)
      if (!blob) {
        errorRef.current()
        return
      }
      const paint = (image: HTMLImageElement) => {
        if (!active || index < paintedFrame) return
        paintedFrame = index
        const width = clip.kind === "atlas" ? clip.frameWidth : image.naturalWidth
        const height = clip.kind === "atlas" ? clip.frameHeight : image.naturalHeight
        if (!width || !height) {
          errorRef.current()
          return
        }
        const scale = Math.min(size / width, size / height)
        const targetWidth = width * scale,
          targetHeight = height * scale
        context.clearRect(0, 0, size, size)
        context.drawImage(
          image,
          clip.kind === "atlas" ? (index % clip.columns) * width : 0,
          clip.kind === "atlas" ? Math.floor(index / clip.columns) * height : 0,
          width,
          height,
          (size - targetWidth) / 2,
          size - targetHeight,
          targetWidth,
          targetHeight
        )
        if (!snapshot) {
          snapshot = true
          try {
            runtime.publishSnapshot(key, canvas.toDataURL("image/png"))
          } catch {
            /* The live animation remains usable. */
          }
        }
      }
      const existing = images.get(path)
      if (existing?.complete && existing.naturalWidth) {
        paint(existing)
        return
      }
      const image = existing ?? new Image()
      images.set(path, image)
      if (images.size > 8) images.delete(images.keys().next().value!)
      image.onload = () => paint(image)
      image.onerror = () => {
        if (active) errorRef.current()
      }
      if (!existing) image.src = runtime.objectUrl(key, blob, path)
    }
    previousFrame = reducedMotion ? 0 : mediaFrameAt(clip, clock.current.elapsed).index
    draw(previousFrame)
    const running = !paused && !reducedMotion
    const release = running ? runtime.track("tickers") : undefined
    const tick = (now: number) => {
      if (!active) return
      start ??= now - clock.current.elapsed
      clock.current.elapsed = now - start
      const frame = mediaFrameAt(clip, clock.current.elapsed)
      if (frame.ended) {
        release?.()
        endedRef.current()
        return
      }
      if (frame.index !== previousFrame && now - lastPaint >= (lowPower ? 1000 / 12 : 0)) {
        previousFrame = frame.index
        lastPaint = now
        draw(frame.index)
      }
      raf = requestAnimationFrame(tick)
    }
    if (running) raf = requestAnimationFrame(tick)
    return () => {
      active = false
      cancelAnimationFrame(raf)
      release?.()
      for (const image of images.values()) {
        image.onload = null
        image.onerror = null
      }
    }
  }, [asset, clip, size, paused, reducedMotion, lowPower, cycle])
  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      data-pet-skin-root="media"
      aria-hidden
      style={{ width: size, height: size }}
    />
  )
}

function VideoClip({
  url,
  props,
  onEnded,
  onError,
}: {
  url: string
  props: PetSkinRenderProps
  onEnded(): void
  onError(): void
}) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const video = ref.current
    if (!video) return
    if (props.paused || props.reducedMotion) video.pause()
    else void video.play().catch(() => onError())
  }, [url, props.paused, props.reducedMotion, onError])
  return (
    <video
      ref={ref}
      src={url}
      muted
      playsInline
      aria-hidden
      preload="auto"
      onEnded={onEnded}
      onError={onError}
      style={{
        width: props.size,
        height: props.size,
        objectFit: "contain",
        objectPosition: "center bottom",
      }}
    />
  )
}

function PlaybackSequence({
  asset,
  plan,
  props,
}: {
  asset: MediaPackAsset
  plan: MediaMotionPlan
  props: PetSkinRenderProps
}) {
  const [step, setStep] = useState(0),
    [completed, setCompleted] = useState(false)
  const idle = asset.manifest.states.idle
  const ids = completed ? idle : plan.ids
  const ambient =
    (completed || plan.key.startsWith("idle:")) && step > 0 && step % 4 === 0
      ? asset.manifest.ambient
      : []
  const pool = ambient.length ? ambient : ids
  const id = pool[step % pool.length],
    clip = asset.manifest.clips[id]
  const runtime = getPetSkinRuntime(),
    key = `media:${asset.id}`
  const onEnded = () => {
    if (!plan.repeat) setCompleted(true)
    setStep((value) => value + 1)
  }
  const onError = () => runtime.recordAssetFailure(key, "renderFailed")
  return (
    <div
      data-pet-skin="media"
      data-media-clip={id}
      style={{
        width: props.size,
        height: props.size,
        transform: !clip.noMirror && props.locomotion?.facing === "left" ? "scaleX(-1)" : undefined,
      }}
    >
      {clip.kind === "video" ? (
        <VideoClip
          key={`${id}:${step}`}
          url={runtime.objectUrl(
            key,
            asset.entries.find((entry) => entry.path === clip.file)!.blob,
            clip.file
          )}
          props={props}
          onEnded={onEnded}
          onError={onError}
        />
      ) : (
        <MediaCanvas
          asset={asset}
          clip={clip}
          cycle={step}
          size={props.size}
          paused={props.paused}
          reducedMotion={props.reducedMotion}
          lowPower={props.lowPower}
          onEnded={onEnded}
          onError={onError}
        />
      )}
    </div>
  )
}

function MediaSkinBoundary(props: PetSkinRenderProps) {
  const id = props.selection?.skinId === "media" ? props.selection.packId : undefined
  const runtime = getPetSkinRuntime()
  useSyncExternalStore(runtime.subscribe, runtime.snapshotRevision, runtime.snapshotRevision)
  const generation = id ? runtime.retryGeneration(`media:${id}`) : 0
  const [loaded, setLoaded] = useState<{ id: string; generation: number; asset: MediaPackAsset }>()
  useEffect(() => {
    let active = true
    if (!id) return
    void loadMediaSkinAsset(id)
      .then((asset) => {
        if (!active) return
        if (asset) setLoaded({ id, generation, asset })
        else runtime.recordAssetFailure(`media:${id}`, "modelMissing")
      })
      .catch(() => {
        if (active) runtime.recordAssetFailure(`media:${id}`, "renderFailed")
      })
    return () => {
      active = false
    }
  }, [id, generation, runtime])
  if (
    !id ||
    loaded?.id !== id ||
    loaded.generation !== generation ||
    runtime.assetDiagnostic(`media:${id}`)
  )
    return <>{svgSkin.render(props)}</>
  const plan = planMediaMotion(loaded.asset.manifest, props)
  return (
    <PlaybackSequence
      key={`${id}:${generation}:${plan.key}`}
      asset={loaded.asset}
      plan={plan}
      props={props}
    />
  )
}
export const mediaSkin: PetSkin = {
  id: "media",
  capabilities: PET_SKIN_CAPABILITIES.media,
  render: (props) => <MediaSkinBoundary {...props} />,
}
