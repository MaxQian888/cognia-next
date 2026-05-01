"use client"

import { memo, useRef } from "react"
import * as Tone from "tone"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ToneSynthRichOutputProps {
  prompt?: string
  className?: string
}

export const ToneSynthRichOutput = memo(function ToneSynthRichOutput({
  prompt,
  className,
}: ToneSynthRichOutputProps) {
  const synthRef = useRef<Tone.Synth | null>(null)

  const handlePlay = async () => {
    await Tone.start()
    if (!synthRef.current) {
      synthRef.current = new Tone.Synth().toDestination()
    }
    synthRef.current.triggerAttackRelease("C4", "8n")
  }

  return (
    <div className={cn("rounded-lg border border-border/60 bg-background/70 p-4", className)}>
      {prompt ? <p className="mb-3 text-sm text-muted-foreground">{prompt}</p> : null}
      <Button type="button" onClick={handlePlay}>
        Play Synth
      </Button>
    </div>
  )
})
