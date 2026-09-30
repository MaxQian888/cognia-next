"use client"

import { useInView, useReducedMotion } from "motion/react"
import { useEffect, useRef, useState } from "react"

import { Icon } from "@web/components/icon"
import { BorderBeam } from "@web/components/ui/border-beam"
import { useHasMounted } from "@web/hooks/use-has-mounted"
import type { ProductVideo as ProductVideoAsset } from "@web/lib/product-videos"
import { cn } from "@web/lib/utils"

interface CommonProps {
  video: ProductVideoAsset
  /** What the film shows, as alt text would say it. The player's accessible name. */
  label: string
  /** Sentences under the frame; the provenance line is always one of them. */
  caption?: string
  note: string
  className?: string
}

interface AmbientProps extends CommonProps {
  mode: "ambient"
}

interface FilmProps extends CommonProps {
  mode: "film"
  playLabel: string
  /** Caption track language and its label in the player's menu. */
  captionsLang: string
  captionsLabel: string
}

export type ProductVideoProps = AmbientProps | FilmProps

/**
 * A film recorded from the real application (ADR-0092, product footage
 * amendment; DESIGN.md, Product Footage Rule).
 *
 * Two modes, because the two places a film appears ask different things of it:
 *
 *  - **ambient** — the hero loop. Muted, looping, no controls, and it plays only
 *    while it can be seen: hydrated, motion permitted, in the viewport, tab
 *    visible. `prefers-reduced-motion` never starts it, and the poster it shows
 *    instead is the loop's own resting frame (the task halted on approval), so
 *    the reduced picture is complete rather than a paused first frame. The
 *    stylesheet's reduced-motion belt cannot stop a `<video>`, which is why
 *    this is decided here in script.
 *  - **film** — the section film. It never autoplays: the poster carries a play
 *    affordance, and once the reader starts it the native controls take over,
 *    with a caption track in the page's language.
 *
 * Both render the same frame as a reconstruction or a screenshot would — the
 * stage radius, one restrained border pass — and the same provenance line
 * under it, so the page never presents a recording without saying what it is.
 */
export function ProductVideo(props: ProductVideoProps) {
  const { video, label, caption, note, className } = props

  return (
    <figure className={className} data-video={props.mode}>
      <div
        className="relative overflow-hidden rounded-stage border border-on-stage-hairline bg-stage"
        style={{ aspectRatio: `${video.width} / ${video.height}` }}
      >
        {props.mode === "ambient" ? (
          <AmbientPlayer video={video} label={label} />
        ) : (
          <FilmPlayer
            video={video}
            label={label}
            playLabel={props.playLabel}
            captionsLang={props.captionsLang}
            captionsLabel={props.captionsLabel}
          />
        )}
        <BorderBeam
          size={240}
          duration={12}
          borderWidth={1}
          colorFrom="var(--action)"
          colorTo="var(--hairline-strong)"
          transition={{ repeat: 1 }}
        />
      </div>
      <figcaption className="mt-3 flex flex-col gap-1 font-mono text-xs text-muted">
        {caption ? <span>{caption}</span> : null}
        <span>{note}</span>
      </figcaption>
    </figure>
  )
}

function AmbientPlayer({ video, label }: { video: ProductVideoAsset; label: string }) {
  const ref = useRef<HTMLVideoElement>(null)
  const reduced = useReducedMotion() ?? false
  const mounted = useHasMounted()
  const inView = useInView(ref, { amount: 0.3 })
  const live = mounted && !reduced && inView

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (!live) {
      element.pause()
      return
    }
    const sync = () => {
      if (document.hidden) {
        element.pause()
        return
      }
      // Autoplay of a muted inline video is allowed everywhere this site
      // targets; a refusal (data saver, an embedding policy) leaves the poster,
      // which is already the complete picture.
      void element.play().catch(() => undefined)
    }
    sync()
    document.addEventListener("visibilitychange", sync)
    return () => {
      document.removeEventListener("visibilitychange", sync)
      element.pause()
    }
  }, [live])

  return (
    <video
      ref={ref}
      className="block h-full w-full object-cover"
      src={video.src}
      poster={video.poster}
      width={video.width}
      height={video.height}
      muted
      loop
      playsInline
      preload="metadata"
      aria-label={label}
      data-live={live ? "true" : "false"}
    />
  )
}

function FilmPlayer({
  video,
  label,
  playLabel,
  captionsLang,
  captionsLabel,
}: {
  video: ProductVideoAsset
  label: string
  playLabel: string
  captionsLang: string
  captionsLabel: string
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const [started, setStarted] = useState(false)

  const start = () => {
    const element = ref.current
    if (!element) return
    setStarted(true)
    void element.play().catch(() => setStarted(false))
  }

  return (
    <>
      <video
        ref={ref}
        className="block h-full w-full object-cover"
        src={video.src}
        poster={video.poster}
        width={video.width}
        height={video.height}
        controls={started}
        playsInline
        preload="none"
        aria-label={label}
        onPlay={() => setStarted(true)}
      >
        {video.captions ? (
          <track
            kind="captions"
            src={video.captions}
            srcLang={captionsLang}
            label={captionsLabel}
            default
          />
        ) : null}
      </video>
      {started ? null : (
        <button
          type="button"
          onClick={start}
          // The whole frame starts the film; the chip sits in the corner because
          // the poster is the opening title card, whose words are centred.
          className={cn(
            "group absolute inset-0 flex items-end justify-start p-4 sm:p-6",
            "focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-action"
          )}
        >
          <span className="flex items-center gap-3 rounded-control border border-on-stage-hairline bg-graphite/90 px-5 py-3 font-mono text-xs uppercase tracking-widest text-on-stage transition-colors group-hover:border-action">
            <Icon name="play" size={16} className="text-action" />
            {playLabel}
          </span>
        </button>
      )}
    </>
  )
}
