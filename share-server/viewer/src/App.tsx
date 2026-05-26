import { useEffect, useState } from "react"
import { loadShare, decryptEnvelope, type LoadState } from "./share-loader"
import type { SharePayload } from "@/lib/share/types"
import { PayloadView } from "./PayloadView"

// Same-origin in production (the worker serves this SPA), so a relative base
// works. Overridable for local dev against a separately-running worker.
const BASE_URL = import.meta.env.VITE_SHARE_BASE_URL ?? ""

export function App() {
  const [state, setState] = useState<LoadState>({ status: "loading" })

  useEffect(() => {
    loadShare(BASE_URL, window.location.pathname, window.location.hash).then(setState)
  }, [])

  useEffect(() => {
    if (state.status === "ready" && state.payload.title) {
      document.title = `${state.payload.title} · cognia`
    }
  }, [state])

  return (
    <main className="viewer">
      <Body state={state} onState={setState} />
      <footer className="viewer__footer">
        Shared via cognia · end-to-end encrypted · the server never sees the contents
      </footer>
    </main>
  )
}

function Body({ state, onState }: { state: LoadState; onState: (s: LoadState) => void }) {
  switch (state.status) {
    case "loading":
      return <Centered>Decrypting…</Centered>
    case "unavailable":
      return (
        <Centered>
          <h1>This link is no longer available</h1>
          <p>It may have expired, been viewed the maximum number of times, or been revoked.</p>
        </Centered>
      )
    case "error":
      return (
        <Centered>
          <h1>Can’t open this share</h1>
          <p>{state.message}</p>
        </Centered>
      )
    case "passphrase":
      return (
        <PassphraseGate
          wrong={state.wrong}
          onSubmit={async (pass) => {
            onState({ status: "loading" })
            onState(await decryptEnvelope(state.envelope, state.key, pass))
          }}
        />
      )
    case "ready":
      return <PayloadView payload={state.payload} />
  }
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="viewer__centered">{children}</div>
}

function PassphraseGate({
  wrong,
  onSubmit,
}: {
  wrong?: boolean
  onSubmit: (passphrase: string) => void
}) {
  const [value, setValue] = useState("")
  return (
    <div className="viewer__centered">
      <h1>Passphrase required</h1>
      <p>This share is protected with an extra passphrase.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (value) onSubmit(value)
        }}
      >
        <input
          type="password"
          aria-label="Passphrase"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Passphrase"
        />
        <button type="submit">Unlock</button>
      </form>
      {wrong ? <p className="viewer__error">That passphrase didn’t work — try again.</p> : null}
    </div>
  )
}

export { PayloadView }
export type { SharePayload }
export const __TESTING__ = { BASE_URL }
