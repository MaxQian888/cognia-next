// Native acceptance harness for the cloud-document P0 boundaries
// (docs/reports/2026-10-22-cloud-documents-p0-boundaries.md). Runs the
// production remote-doc search, staging, attachment intake, preparation and
// proxy fetch against in-memory document accounts. Built by ./build.mjs, which
// swaps the provider registry and host-only modules for the stubs it declares.
// Developer-only test page: its copy is deliberately not i18n-wired.
import { useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { NextIntlClientProvider } from "next-intl"
import { Toaster } from "sonner"
import messages from "@/i18n/messages/en.json"
import { useRemoteDocSearch } from "@/hooks/chat/use-remote-doc-search"
import { useAttachmentIntake } from "@/components/chat/composer/hooks/use-attachment-intake"
import type { DocsProviderAccount, RemoteDocRef } from "@/lib/docs-providers/types"
import { createProxyFetch } from "@/lib/network/proxy-fetch"

/** Control surface the build's stubbed `@/lib/docs-providers` installs on `window`. */
interface P0Fixture {
  accounts: DocsProviderAccount[]
  holdSearch: boolean
  holdFetch: boolean
  holdPrep: boolean
  empty: boolean
  notify: () => void
  releaseSearch: () => void
  releaseFetch: () => void
  releasePrep: () => void
}

declare global {
  interface Window {
    p0Fixture: P0Fixture
    p0NativeFetch: typeof fetch
  }
}

// Read lazily: the stub assigns it while the hook modules above evaluate.
const fixture = (): P0Fixture => window.p0Fixture

window.p0NativeFetch = createProxyFetch()

function Harness() {
  const search = useRemoteDocSearch({ namespace: "p0:", query: "spec" })
  const [session, setSession] = useState("chat-a")
  const [files, setFiles] = useState<File[]>([])
  const [bodies, setBodies] = useState<string[]>([])
  const [citations, setCitations] = useState(0)
  const [status, setStatus] = useState("Ready")
  const [held, setHeld] = useState(false)
  const [saved, setSaved] = useState<RemoteDocRef | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const intake = useAttachmentIntake({
    destinationKey: session,
    attachments: {
      files,
      add: (incoming) => {
        setFiles((prior) => [...prior, ...incoming])
        void Promise.all(incoming.map((f) => f.text())).then((texts) =>
          setBodies((prior) => [...prior, ...texts])
        )
      },
    },
    attachmentCitations: { expect: () => setCitations((value) => value + 1) },
    textInput: { value: "", setInput: () => {} },
    textareaRef: textarea,
    setCaret: () => {},
    isDesktop: false,
    acceptMotion: false,
    t: (key) => key,
    tAttach: (key) => key,
  })
  const stage = async (doc: RemoteDocRef | null | undefined = search.items[0]) => {
    if (!doc || !search.accountId) return
    setStatus("Fetching")
    const file = await intake.stageRemoteDoc({ providerId: "p0", accountId: search.accountId, doc })
    setStatus(file ? "Attached" : "Discarded")
  }
  return (
    <main>
      <h1>P0 native fixture</h1>
      <p>
        Production search, staging, intake, preparation and proxy fetch; in-memory document accounts
        only.
      </p>
      <label>
        Account
        <select
          aria-label="Account"
          value={search.accountId ?? ""}
          onChange={(e) => search.setAccountId(e.target.value)}
        >
          {search.accounts?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <output aria-label="Results">
        {search.items.length
          ? search.items.map((d) => `${d.title} / ${d.accountBinding?.accountId}`).join(", ")
          : "No results"}
      </output>
      <button onClick={() => setSaved(search.items[0] ?? null)}>Save current pick</button>
      <button onClick={() => void stage()}>Stage selected</button>
      <button onClick={() => void stage(saved)}>Stage saved pick</button>
      <button
        onClick={() => {
          fixture().holdSearch = !fixture().holdSearch
          setHeld(fixture().holdSearch)
        }}
      >
        Toggle search hold
      </button>
      <output aria-label="Search hold">{held ? "Held" : "Free"}</output>
      <button onClick={() => fixture().releaseSearch()}>Release search</button>
      <button
        onClick={() => {
          fixture().holdFetch = true
          setStatus("Fetch held")
        }}
      >
        Hold fetch
      </button>
      <button
        onClick={() => {
          fixture().holdFetch = false
          fixture().releaseFetch()
        }}
      >
        Release fetch
      </button>
      <button
        onClick={() => {
          fixture().holdPrep = true
          setStatus("Preparation held")
        }}
      >
        Hold preparation
      </button>
      <button
        onClick={() => {
          fixture().holdPrep = false
          fixture().releasePrep()
        }}
      >
        Release preparation
      </button>
      <button onClick={() => setSession((value) => (value === "chat-a" ? "chat-b" : "chat-a"))}>
        Switch chat
      </button>
      <button
        onClick={() => {
          fixture().accounts = fixture().accounts.filter((a) => a.id !== search.accountId)
          fixture().notify()
          setStatus("Disconnected")
        }}
      >
        Disconnect selected
      </button>
      <button
        onClick={() => {
          fixture().empty = !fixture().empty
          setStatus(fixture().empty ? "Empty enabled" : "Empty disabled")
        }}
      >
        Toggle empty body
      </button>
      <button
        onClick={() => {
          setFiles([])
          setBodies([])
          setCitations(0)
          setStatus("Cleared")
        }}
      >
        Clear attachments
      </button>
      <div data-composer-root="" data-composer-session={session}>
        <textarea ref={textarea} aria-label="Fixture message" />
      </div>
      <output aria-label="Chat">{session}</output>
      <output aria-label="Attachment count">{files.length}</output>
      <output aria-label="Citation count">{citations}</output>
      <output aria-label="Stage status">{status}</output>
      <pre aria-label="Attachment body">{bodies.join("\n")}</pre>
      <Toaster />
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider locale="en" messages={messages}>
    <Harness />
  </NextIntlClientProvider>
)
