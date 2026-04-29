"use client"

// Tiny chip row at the very bottom of the composer reminding the user of
// the most useful shortcuts. Kept terse to avoid stealing attention.

export function HelperHints() {
  return (
    <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1.5 text-[10px] text-muted-foreground/70">
      <Hint>⏎ Send · ⇧⏎ New line</Hint>
      <Hint>Drop / paste images</Hint>
      <Hint>
        Try <code className="font-mono">/</code> <code className="font-mono">@</code>{" "}
        <code className="font-mono">!</code> <code className="font-mono">#</code>
      </Hint>
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border/50 bg-background/60 px-2 py-0.5">
      {children}
    </span>
  )
}
