/**
 * Cognia Browser Companion — the contract between the extension side panel and
 * the desktop Host.
 *
 * One module, shared by both ends, because the two are separately built: the
 * app compiles this out of `types/`, the extension imports it through
 * `@cognia/companion-client`. A second copy would drift the moment a limit
 * changed on one side only, and the failure would show up as a submission the
 * panel believed was in bounds and the Host refused.
 *
 * ## What is deliberately not here
 *
 * There is no model, provider, cwd, tool set or permission mode. A page
 * captured in a browser describes *what to work on*, never *how* — the task
 * inherits whatever a new session on the chosen workspace would have used, so
 * a compromised or merely over-eager extension cannot widen the agent it
 * starts.
 *
 * There is no `runtimeTargetId` either. The four ids in
 * `lib/runtime/runtime-target.ts` name a *client's* execution identity, and
 * `resolveRuntimeTarget()` returns `null` for `tauri` precisely because that
 * shell **is** the host. An extension executes nothing; the Host does. What
 * the user actually chooses is a workspace (ADR-0144), which is what the
 * request carries.
 */

/**
 * How much of the page the user chose to send.
 *
 * Three modes rather than a boolean because the middle one is the common case:
 * a selection is what a person has already told the browser they care about,
 * so it is the default whenever one exists, and it is cheap and legible in the
 * preview. `readable-page` is never implicit — whole-page text is the largest
 * and least predictable thing this feature can send.
 */
export type BrowserCaptureMode = "metadata" | "selection" | "readable-page" | "article"

/**
 * Every mode this build of the contract knows.
 *
 * `article` (ADR-0228 §1) is the page's main content as Markdown — what a
 * reader or a clipper keeps — where `readable-page` is everything visible as
 * plain text. A Host lists the modes it accepts in
 * {@link BrowserCompanionCapabilityV1.supportedCaptureModes}; a panel never
 * sends one the Host did not list.
 */
export const BROWSER_CAPTURE_MODES: readonly BrowserCaptureMode[] = Object.freeze([
  "metadata",
  "selection",
  "readable-page",
  "article",
])

/**
 * Byte ceilings, in UTF-8 bytes rather than characters.
 *
 * Characters would be the wrong unit twice over: the wire budget is bytes, and
 * a CJK page hits a byte limit at roughly a third of the character count, so a
 * character-denominated cap silently means something different per language.
 *
 * The Host re-checks all of these. The extension enforces them too, but only so
 * the preview can say *what was cut* — a client-side limit is a courtesy, never
 * the boundary.
 */
export interface BrowserContextLimits {
  instructionBytes: number
  selectionBytes: number
  readableTextBytes: number
  /** Ceiling on the whole serialized request, envelope included. */
  requestBytes: number
  /**
   * The ADR-0228 ceilings. Optional because a Host built before them sends a
   * `limits` object without them; a panel fills the gaps from
   * {@link BROWSER_CONTEXT_LIMITS}, and only uses a feature the Host listed.
   */
  /** Article Markdown, per page. */
  articleBytes?: number
  /** Video transcript, per page. */
  transcriptBytes?: number
  /** Pages in one submission, the primary page included. */
  maxPages?: number
  /** Sum of every page's selection, readable text, article and transcript. */
  totalContextBytes?: number
  /** Attachments in one submission. */
  maxAttachments?: number
  /** Bytes per attachment. */
  attachmentBytes?: number
}

export const BROWSER_CONTEXT_LIMITS: Readonly<Required<BrowserContextLimits>> = Object.freeze({
  instructionBytes: 8 * 1024,
  selectionBytes: 32 * 1024,
  readableTextBytes: 128 * 1024,
  // Raised for multi-page submissions (ADR-0228 §2): the instruction plus the
  // total context budget, with room for the envelope and JSON escaping. The
  // companion router's per-route body ceiling for `browser_context_submit`
  // (`crates/cognia-companion/src/server.rs`) is this same number.
  requestBytes: 640 * 1024,
  articleBytes: 128 * 1024,
  transcriptBytes: 128 * 1024,
  maxPages: 10,
  totalContextBytes: 512 * 1024,
  maxAttachments: 6,
  attachmentBytes: 10 * 1024 * 1024,
})

/** The limits a Host sent, with anything an older Host did not say filled in. */
export function resolveBrowserContextLimits(
  limits: BrowserContextLimits | undefined
): Required<BrowserContextLimits> {
  return { ...BROWSER_CONTEXT_LIMITS, ...(limits ?? {}) }
}

/** Text that may have been cut, and says so. */
export interface BrowserCapturedText {
  text: string
  /**
   * How {@link text} is written. Absent means `plain`, which is all a capture
   * could be before ADR-0228. A selection captured as Markdown keeps its
   * links, emphasis, lists and code; the Host renders it as-is inside the
   * fence and never interprets it.
   */
  format?: "plain" | "markdown"
  /**
   * Whether {@link text} is shorter than what was on the page.
   *
   * Carried explicitly rather than inferred from a length comparison the Host
   * cannot make: only the extension saw the original. It is surfaced in the
   * preview because "the agent read the whole page" and "the agent read the
   * first 128 KiB" are different claims and the user is the one who has to
   * know which one they are making.
   */
  truncated: boolean
}

export interface BrowserReadableText extends BrowserCapturedText {
  /** Length of the extracted text before truncation, in characters. */
  originalCharacterCount: number
}

/**
 * One captured page.
 *
 * Text only — never HTML. HTML would carry script, style, tracking markup and
 * anything else the page felt like embedding into a prompt, and none of that
 * is context. It also cannot be reviewed in a preview, which is the whole
 * mechanism by which the user consents to what gets sent.
 */
/**
 * What a page says about itself, read from `<meta>`, Open Graph and JSON-LD.
 *
 * Every field is the page's own claim and therefore as untrusted as its text;
 * the Host renders it inside the same fence.
 */
export interface BrowserPageMetadataV1 {
  byline?: string
  /** ISO 8601, as the page declared it. */
  publishedAt?: string
  siteName?: string
  /** BCP 47, from `<html lang>` or `og:locale`. */
  lang?: string
  description?: string
  /** Normalized like {@link BrowserPageContextV1.url}. */
  canonicalUrl?: string
  /** What the page is, when it says: `article`, `video`, `product`, … */
  kind?: string
}

/**
 * A video's spoken words, when the page exposes captions.
 *
 * `unavailable` is a stated outcome rather than an absent field, so "this
 * video has no captions" never reads as "the extension forgot to look".
 */
export type BrowserTranscriptV1 =
  | {
      status: "available"
      /** One line per caption cue: `[mm:ss] text`. */
      text: string
      truncated: boolean
      /** BCP 47 code of the track that was read. */
      language?: string
      /** Whether the track was generated by speech recognition. */
      autoGenerated?: boolean
    }
  | {
      status: "unavailable"
      reason: "no_captions" | "not_a_video" | "fetch_failed"
    }

/** A link the user right-clicked, normalized like the page URL. */
export interface BrowserLinkContextV1 {
  url: string
  text?: string
}

/** An image the user right-clicked. The bytes travel as an attachment. */
export interface BrowserImageContextV1 {
  url: string
  alt?: string
}

export interface BrowserPageContextV1 {
  schemaVersion: 1
  captureMode: BrowserCaptureMode
  /**
   * The page address, already normalized by the extension.
   *
   * Credentials, query and fragment are stripped by default — query strings
   * routinely carry session tokens, tracking ids and search terms that the
   * title alone would not have revealed. The user can opt a full URL back in
   * per capture; nothing does it silently.
   */
  url: string
  title: string
  capturedAt: number
  selection?: BrowserCapturedText
  readableText?: BrowserReadableText
  /** The main content as Markdown, for `article` captures. */
  article?: BrowserReadableText
  metadata?: BrowserPageMetadataV1
  transcript?: BrowserTranscriptV1
  link?: BrowserLinkContextV1
  image?: BrowserImageContextV1
}

/**
 * An attachment staged through `browser_attachment_upload_*` for the
 * submission that names it.
 *
 * The id is the Host's, returned by the commit; the Host resolves it against
 * the uploads this device staged under this submission id, so an extension
 * cannot point a submission at bytes it did not upload for it.
 */
export interface BrowserAttachmentRefV1 {
  attachmentId: string
  kind: BrowserAttachmentKind
}

export type BrowserAttachmentKind = "screenshot" | "pdf" | "image"

/** The media types an attachment may have. */
export const BROWSER_ATTACHMENT_MEDIA_TYPES: readonly string[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
])

export interface BrowserAttachmentUploadInitRequestV1 {
  submissionId: string
  name: string
  mediaType: string
  kind: BrowserAttachmentKind
  /** Bytes. */
  size: number
  /** Lower-case hex SHA-256 of the whole file. */
  hash: string
}

export interface BrowserAttachmentUploadInitResponseV1 {
  uploadId: string
  /** Raw bytes per chunk, before base64. */
  chunkSize: number
  /** Bytes the Host already holds, for a resumed upload. */
  receivedBytes: number
  /** Present when the Host already holds the whole file. */
  attachmentId?: string
}

export interface BrowserAttachmentUploadChunkRequestV1 {
  uploadId: string
  offset: number
  dataBase64: string
}

export interface BrowserAttachmentUploadChunkResponseV1 {
  receivedBytes: number
}

export interface BrowserAttachmentUploadCommitResponseV1 {
  attachmentId: string
}

/** What the side panel sends when the user submits. */
export interface BrowserContextSubmitRequestV1 {
  /**
   * Client-minted UUID, doubling as the `Idempotency-Key` header.
   *
   * One id rather than two so a retry cannot accidentally present a fresh key
   * for the same submission — which is exactly the case that would create a
   * second session out of one user action.
   */
  submissionId: string
  /** From {@link BrowserCompanionCapabilityV1.workspaces}. */
  workspaceId: string
  /**
   * From {@link BrowserCompanionCapabilityV1.deliveryTargets}.
   *
   * Optional so an extension built before targets existed keeps working
   * unchanged: absent means the Host's default target, which is a new task —
   * the only thing that submission could ever have meant.
   */
  targetId?: string
  /**
   * Values for {@link BrowserDeliveryTargetV1.params}, by parameter id.
   *
   * Text only. The Host keeps the declaration and reads it back, so an entry
   * naming a parameter the target does not declare is ignored — a client cannot
   * introduce a substitution by sending one.
   */
  targetParams?: Record<string, string>
  instruction: string
  /** Overrides the title derived from the page, when the user typed one. */
  suggestedTitle?: string
  context: BrowserPageContextV1
  /**
   * More pages in the same submission (ADR-0228 §2), in the order the user
   * arranged them. Only sent to a Host that lists `multi-page`.
   */
  additionalContexts?: BrowserPageContextV1[]
  /** Staged attachments. Only sent to a Host that lists `attachments`. */
  attachments?: BrowserAttachmentRefV1[]
  /**
   * For a `browser-agent` target: the tab the agent starts on — the one the
   * user captured. The extension's own tab id, meaningful only to it; the Host
   * passes it back on every operation so the conversation's first tab is the
   * page the user was looking at.
   */
  browserAgent?: { tabId: number }
}

/**
 * Where a submission has got to.
 *
 * `host_unavailable` is a real state, not an error: the Host accepted the work
 * and the runtime is not there to run it yet. Collapsing it into `failed`
 * would tell the user to resubmit something that is still queued.
 */
export type BrowserSubmissionStatus =
  | "submitting"
  | "queued"
  | "running"
  | "needs_input"
  | "completed"
  | "cancelled"
  | "failed"
  | "host_unavailable"

export const BROWSER_TERMINAL_STATUSES: readonly BrowserSubmissionStatus[] = Object.freeze([
  "completed",
  "cancelled",
  "failed",
])

/** Whether nothing further will happen to this submission on its own. */
export function isTerminalBrowserSubmissionStatus(status: BrowserSubmissionStatus): boolean {
  return BROWSER_TERMINAL_STATUSES.includes(status)
}

export interface BrowserContextSubmitResponseV1 {
  submissionId: string
  /**
   * The conversation this started, when it started one.
   *
   * Absent for work that has no transcript — a filed issue, an agent task
   * queued for later. `deepLink` is the reference that always resolves; this is
   * here because a client that only ever starts conversations still reads it.
   */
  sessionId?: string
  /** Absent means `session`. */
  workKind?: BrowserWorkKind
  acceptedAt: number
  status: BrowserSubmissionStatus
  /** `cognia://session/<id>` — opens the task in the desktop app. */
  deepLink: string
}

/**
 * One row of the side panel's recent list.
 *
 * Deliberately thin. The instruction and the page text are not stored on the
 * Host beyond the transcript that already owns them, and they are not stored
 * in the extension at all, so there is nothing here to read them back from.
 * What a person needs to re-find a task is its title, where it came from, and
 * whether it is still running.
 */
export interface BrowserContextSubmissionSummaryV1 {
  submissionId: string
  /** Absent for work with no transcript. See the submit response. */
  sessionId?: string
  /** Absent means `session`. */
  workKind?: BrowserWorkKind
  title: string
  /** Hostname only — never the full URL. */
  sourceHost: string
  captureMode: BrowserCaptureMode
  /** Pages in the submission, when more than one (ADR-0228 §2). */
  pageCount?: number
  /** Attachments in the submission, when any. */
  attachmentCount?: number
  status: BrowserSubmissionStatus
  submittedAt: number
  updatedAt: number
  deepLink: string
}

export interface BrowserContextSubmissionSummaryPageV1 {
  items: BrowserContextSubmissionSummaryV1[]
  /** Present when another page exists (ADR-0175 B3). Hand it back as `pageToken`. */
  nextPageToken?: string
  /**
   * A digest of everything `browser_companion_capability` would answer.
   *
   * Rides along here because this is the call the panel already makes on a
   * timer, and the capability is not: a Host whose theme, workspaces or
   * delivery targets changed had no way to say so to a panel that was already
   * open, and the panel had no cheap way to ask. When this differs from the
   * value that came with the capability it holds, it re-reads it — one string
   * per poll instead of a palette, and it covers every part of the capability
   * rather than only the theme.
   *
   * It replaced a `cursor` no producer ever set. Paging is `nextPageToken`
   * above, which the Host does emit: offset paging over the
   * device's newest 100 rows, optionally filtered by `query`.
   */
  capabilityRevision?: string
}

export interface BrowserContextSubmissionStatusV1 {
  submissionId: string
  /** Absent for work with no transcript. See the submit response. */
  sessionId?: string
  /** Absent means `session`. */
  workKind?: BrowserWorkKind
  status: BrowserSubmissionStatus
  updatedAt: number
  /** A machine-readable reason, present only on `failed`. */
  errorCode?: string
  deepLink: string
}

/**
 * What a task answered, for the panel to show without leaving the browser.
 *
 * Extends the status reply rather than being a separate shape, because a
 * result is a status with the answer attached — a task that is still running
 * has one and not the other, and two shapes would make the panel ask twice.
 *
 * `text` is the last assistant message, capped in **bytes** and flagged when it
 * was cut. Not the whole transcript: the panel is a side panel, the transcript
 * is what Cognia is for, and a submission's own page text is already in there.
 */
export interface BrowserContextResultV1 extends BrowserContextSubmissionStatusV1 {
  /** Absent until the task has actually said something. */
  text?: string
  /** Whether {@link text} is shorter than what the task produced. */
  truncated?: boolean
  /** When the answer was written, epoch milliseconds. */
  answeredAt?: number
}

/** Byte ceiling on a returned answer. */
export const BROWSER_RESULT_TEXT_BYTES = 32 * 1024

/**
 * The Host's resolved appearance, handed to the extension so the side panel
 * looks like the app rather than like an approximation of it.
 *
 * `cssVars` is the complete set from `lib/appearance/theme-token-catalog.ts`,
 * already resolved: a custom theme, an imported VSCode theme and the stock
 * palette all arrive here the same way. Sending values rather than a theme id
 * is what makes drift impossible — there is no second copy of the palette in
 * the extension to fall behind.
 */
export interface BrowserCompanionAppearanceV1 {
  mode: "light" | "dark"
  /** CSS custom-property name → value, e.g. `--background` → `oklch(1 0 0)`. */
  cssVars: Record<string, string>
  /** `--radius` in rem; the named control/panel/stage scale derives from it. */
  radiusBaseRem: number
  /** `--pill-radius` in px. 9999 is a capsule, 0 is square. */
  pillRadiusPx: number
  density: "compact" | "comfortable" | "spacious"
}

/** A workspace the user may aim a submission at. */
export interface BrowserCompanionWorkspaceV1 {
  id: string
  label: string
  isDefault: boolean
}

/**
 * What a submission may be aimed at, beyond which workspace it lands in.
 *
 * ## Why the extension is allowed to choose one
 *
 * `browser.submit` is argued as one closed effect, and the argument survives a
 * list because the list is the Host's. The extension picks a label out of what
 * the Host offered and sends back the id it was given; the Host resolves that
 * id against its own catalogue and builds the action itself. That is exactly
 * the shape `workspaceId` already had — an id outside the offered set is
 * refused as stale state, not honoured as a new capability — and it is the
 * reason a target id is opaque here. Nothing in it is parsed by the extension,
 * and nothing in it is trusted by the Host.
 *
 * What the extension still cannot do is unchanged: it names no session, no
 * model, no tool set and no permission mode, and it cannot construct a target
 * that was not offered.
 *
 * ## Why `kind` is here at all
 *
 * Only so the panel can say what will happen — "start a new task" reads
 * differently from "add to the task you started on this page". It is a label
 * hint, never an instruction: the Host derives the effect from its own
 * catalogue entry, so a client that sent a `kind` disagreeing with the id it
 * quoted would change nothing.
 */
export type BrowserDeliveryTargetKind =
  | "chat"
  | "session"
  | "template"
  | "issue"
  | "agent-task"
  /**
   * A new conversation that may act in this browser (ADR-0228 §6). Offered
   * only to a device holding `browser.drive` with a live device socket.
   */
  | "browser-agent"

/**
 * What a submission produced, and therefore what its deep link points at.
 *
 * Absent means `session`, which is what every submission was before an issue
 * or an agent task could be one. The panel branches on it for exactly one
 * thing: whether there is a transcript to read an answer out of, or a turn to
 * stop. A filed issue has neither and says so, rather than offering controls
 * that would refuse.
 */
export type BrowserWorkKind = "session" | "issue" | "agent-task"

/**
 * A value a target needs before it can run.
 *
 * Only the two kinds a browser can actually fill. A Cognia template may also
 * declare a `resource` parameter — a file or a workspace entity picked through
 * the `@` menu — and a side panel has no picker for one and must not grow a way
 * to enumerate the Host's files. A template with such a parameter is simply not
 * offered, which is a smaller lie than offering it with a field that cannot be
 * completed.
 */
export interface BrowserTargetParamV1 {
  /** Matches the `{{id}}` token in the target's text. */
  id: string
  label: string
  description?: string
  required: boolean
  kind: "string" | "enum"
  /** Choices, for `kind: "enum"`. */
  options?: string[]
  /** Offered as the starting value, from the template or from its last use. */
  defaultValue?: string
  /** Render as a multi-line field. */
  multiline?: boolean
}

export interface BrowserDeliveryTargetV1 {
  /** Opaque to the extension. Minted and re-resolved by the Host. */
  id: string
  kind: BrowserDeliveryTargetKind
  /**
   * What to show.
   *
   * For `session` this is the conversation's own title — user data, and the
   * same in any language. For `chat` it is an English fallback: the Host cannot
   * know the browser's UI language (nothing in the request carries one), so a
   * Cognia panel renders its own translation for that kind and any other client
   * shows this verbatim.
   */
  label: string
  /**
   * Whether the panel should preselect this one.
   *
   * Exactly one target is the default. A Host that offered none would leave the
   * panel choosing for the user out of list order, which is not a decision the
   * extension is in a position to make.
   */
  isDefault: boolean
  /**
   * The workspace this target belongs to, when it belongs to one.
   *
   * Absent means "available in every workspace" — `chat:new` is, because a new
   * task is created in whichever workspace the user picked. A target that names
   * one is filtered to it, because a session already lives somewhere and
   * offering it under a different workspace would promise a move that the
   * submission does not perform.
   */
  workspaceId?: string
  /**
   * A one-line note under the label, when the label alone is ambiguous.
   *
   * Two sessions started from the same page have the same title; what tells
   * them apart is when they ran and how they are doing.
   */
  detail?: string
  /**
   * Values this target needs before it will run.
   *
   * Absent or empty for a target that needs none. The Host re-reads the
   * declaration when the submission arrives, so a panel sending a value for a
   * parameter that no longer exists has it dropped rather than smuggled
   * through.
   */
  params?: BrowserTargetParamV1[]
}

/**
 * What the Host can do, asked once per panel open.
 *
 * The limits travel with it rather than being compiled into the extension:
 * the extension updates on the store's schedule and the Host on the user's, so
 * a build-time constant would be wrong on exactly the machines where the two
 * have drifted.
 */
export interface BrowserCompanionCapabilityV1 {
  schemaVersion: 1
  limits: BrowserContextLimits
  supportedCaptureModes: BrowserCaptureMode[]
  workspaces: BrowserCompanionWorkspaceV1[]
  appearance: BrowserCompanionAppearanceV1
  /**
   * Whether the Host's own theme setting is "follow the system".
   *
   * `mode` is always a concrete `light` or `dark`, so an older panel keeps
   * working: widening that enum would break `applyAppearance`, which only knows
   * how to toggle the two classes. This flag is the extra bit — a panel that
   * understands it asks again with its own `prefers-color-scheme` as
   * `preferredMode`, because the Host cannot see the browser's system theme and
   * had been resolving `system` to dark for everyone.
   */
  followsSystem?: boolean
  /**
   * Where a submission may be aimed, default first.
   *
   * Optional, and `schemaVersion` deliberately stays `1`. The panel compares
   * that version for equality, so bumping it would make every already-installed
   * extension declare the Host incompatible and refuse to do anything — over an
   * addition none of them needs. Absent means an older Host that only starts
   * new tasks, which is what the panel falls back to.
   */
  deliveryTargets?: BrowserDeliveryTargetV1[]
  /**
   * What this Host understands beyond the ADR-0154 contract.
   *
   * The panel sends a field only when the feature that carries it is listed:
   * a Host that predates a field rebuilds the request from the keys it knows
   * and would drop the rest without saying so.
   */
  features?: BrowserCompanionFeature[]
  /**
   * Whether this device may be driven (`browser.drive`), so the panel can
   * offer agent mode or say how to turn it on.
   */
  driveAllowed?: boolean
}

export type BrowserCompanionFeature =
  | "article"
  | "markdown-selection"
  | "metadata"
  | "transcript"
  | "link-image"
  | "multi-page"
  | "attachments"
  | "list-paging"
  | "device-socket"
  | "browser-agent"

/** Every feature this build of the contract defines, in a stable order. */
export const BROWSER_COMPANION_FEATURES: readonly BrowserCompanionFeature[] = Object.freeze([
  "article",
  "markdown-selection",
  "metadata",
  "transcript",
  "link-image",
  "multi-page",
  "attachments",
  "list-paging",
  "device-socket",
  "browser-agent",
])

export interface BrowserContextListRequestV1 {
  /** 1–50. */
  pageSize?: number
  /** The previous page's `nextPageToken`, unchanged. */
  pageToken?: string
  /** Case-insensitive match on the title and source host. */
  query?: string
}
