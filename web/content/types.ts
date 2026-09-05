/**
 * The website's copy contract (ADR-0092 §5).
 *
 * Marketing copy here is structured — bullet arrays, a run-strategy matrix, a
 * three-column footer, six ordered task states — so it lives in typed modules
 * rather than an ICU message bundle. `en.ts` and `zh.ts` each implement
 * `SiteCopy`, which means a key missing from, or extra in, either locale is a
 * `pnpm typecheck` failure rather than a runtime fallback nobody notices.
 *
 * Nothing in this file is rendered directly; every user-facing string in a
 * `.tsx` file must come from here.
 */

// Type-only imports, erased at build: the copy names a bespoke mark and a
// build-time figure by key, and both keys are owned by the module that draws
// or counts them, so a rename there is a typecheck failure here.
import type { GlyphName } from "@web/components/glyph"
import type { InventoryKey } from "@web/lib/evidence"

/** Per-route `<title>` / `<meta name="description">`. */
export interface RouteMeta {
  title: string
  description: string
}

export interface MetaCopy {
  /** Suffix appended to every page title except the homepage. */
  titleTemplate: string
  home: RouteMeta
  product: RouteMeta
  workflows: RouteMeta
  plugins: RouteMeta
  trust: RouteMeta
  download: RouteMeta
  useCasesDevelopment: RouteMeta
  useCasesResearch: RouteMeta
  changelog: RouteMeta
}

export interface NavLink {
  label: string
  /** Locale-agnostic route (`/trust`); `localePath()` prefixes it. */
  route: string
}

export interface NavMenuItem extends NavLink {
  description: string
}

export interface NavCopy {
  brand: string
  /** §5: Product collects Chat, Agents and Knowledge as anchors on /product. */
  productMenu: {
    label: string
    items: NavMenuItem[]
  }
  links: NavLink[]
  docsLabel: string
  sourceLabel: string
  downloadLabel: string
  openMenu: string
  closeMenu: string
  skipToContent: string
  switchLanguage: string
  switchLanguageTo: string
  themeToggle: string
  themeLight: string
  themeDark: string
  themeSystem: string
  /** Accessible name for the homepage's reading-position rail. */
  sectionIndexLabel: string
}

/**
 * Exactly one of `route` (a site path), `href` (an absolute external URL) or
 * `docsPath` (a path on the docs origin, which lives on a different hostname)
 * is set. The link component resolves whichever is present.
 */
export interface LinkTarget {
  label: string
  route?: string
  href?: string
  docsPath?: string
}

export interface FooterColumn {
  title: string
  links: LinkTarget[]
}

export interface FooterCopy {
  columns: FooterColumn[]
  licenseLabel: string
  licenseNote: string
  /** Rendered under the columns; carries no unverifiable claim. */
  colophon: string
}

/**
 * Shared strings that several surfaces need. `download` is the only place the
 * site speaks about installability, and it has to be able to say "there is no
 * release yet" without that reading as an error (ADR-0092 §7).
 */
export interface CommonCopy {
  download: {
    /** Rendered when the release manifest reports at least one release. */
    available: string
    availableFor: string
    /** Rendered when there is no published release — the current reality. */
    unavailable: string
    unavailableSecondary: string
    unavailableExplain: string
    allPlatforms: string
    version: string
    published: string
    platformMacos: string
    platformWindows: string
    platformLinux: string
    detecting: string
  }
  viewSource: string
  readDocs: string
  asOf: string
  stale: string
  learnMore: string
  /** Screen-reader label for the decorative context path in the bento. */
  contextPathLabel: string
  /** First crumb on every sub-page. */
  breadcrumbHome: string
  /** Heading for a sub-page's in-page anchor index. */
  onThisPage: string
  /** Copy-to-clipboard control on the build commands. */
  copyCommand: string
  copiedCommand: string
}

/* -------------------------------------------------------------------------- */
/* Homepage                                                                    */
/* -------------------------------------------------------------------------- */

export interface TrustRailItem {
  label: string
  detail: string
}

/**
 * Labels for the hero's task ticket.
 *
 * Every *value* the ticket shows comes from `DEMO_TASK` and the reconstruction
 * copy that the workbench below it already renders — the ticket introduces no
 * new factual claim, only the labels that let the first screen state the
 * signature task instead of describing it in prose.
 */
export interface HeroTicketCopy {
  label: string
  repositoryLabel: string
  branchLabel: string
  checkLabel: string
  planLabel: string
  stateLabel: string
}

export interface HeroCopy {
  eyebrow: string
  title: string
  subtitle: string
  trustRail: TrustRailItem[]
  ticket: HeroTicketCopy
  stageAlt: string
  stageCaption: string
}

/**
 * The six states of the signature task, in order. `status` is the label shown
 * on the rail; `tone` drives the icon and the token, never colour alone (§8).
 */
export type StepTone = "ready" | "done" | "waiting" | "pending"

export interface SignatureStep {
  key: string
  /**
   * Which reconstructed interface this step shows. Named rather than derived
   * from `key`, because the rail's `action` step shows the `diff` artifact and a
   * silent mapping between the two would be a trap for the next editor.
   */
  artifact: keyof TaskArtifactsCopy
  /** Rail label: Context, Plan, Action, Approval, Test, Artifact. */
  rail: string
  status: string
  tone: StepTone
  headline: string
  body: string
  /** Mono-set detail line: a path, a command, a check name. */
  detail: string
}

export interface SignatureCopy {
  eyebrow: string
  title: string
  subtitle: string
  taskLabel: string
  task: string
  steps: SignatureStep[]
  stepperLabel: string
  previousLabel: string
  nextLabel: string
  playLabel: string
  pauseLabel: string
  stepOf: string
}

export interface BentoPanel {
  key: string
  label: string
  body: string
}

export interface WorkbenchCopy {
  eyebrow: string
  title: string
  subtitle: string
  panels: BentoPanel[]
}

export interface DesktopCopy {
  eyebrow: string
  title: string
  subtitle: string
  capabilities: Array<{ label: string; body: string }>
  stageAlt: string
}

export interface RunStrategy {
  key: string
  name: string
  summary: string
  /** The four questions §4.5 requires every strategy to answer. */
  leaves: string
  receives: string
  tools: string
  approval: string
  docsPath: string
}

export interface RunCopy {
  eyebrow: string
  title: string
  subtitle: string
  headings: {
    strategy: string
    leaves: string
    receives: string
    tools: string
    approval: string
  }
  strategies: RunStrategy[]
  note: string
}

export interface ConnectionItem {
  key: string
  name: string
  reads: string
  canAct: string
  requiresApproval: string
}

/**
 * One external coding agent Cognia interoperates with.
 *
 * `id` selects the vendored brand mark in `content/generated/agent-icons.json`;
 * an id with no mark renders the site's own generic glyph rather than another
 * brand's. `run` and `import` are the two real capabilities — an external-agent
 * preset in `lib/ai/agent/external/presets.ts`, and a session-history adapter in
 * `lib/session-import/adapters/` — and at least one is always true, or the row
 * would be claiming a connection that does not exist.
 */
export interface AgentInterop {
  id: string
  name: string
  run: boolean
  import: boolean
}

export interface ConnectionsCopy {
  eyebrow: string
  title: string
  subtitle: string
  headings: {
    reads: string
    canAct: string
    requiresApproval: string
  }
  items: ConnectionItem[]
  catalogueNote: string
  agents: {
    label: string
    note: string
    runLabel: string
    importLabel: string
    items: AgentInterop[]
  }
}

export interface TrustCard {
  key: string
  label: string
  body: string
  linkLabel: string
  /** External URL (repository, license) or a site route. */
  href?: string
  route?: string
}

export interface ProvenanceStep {
  label: string
  value: string
}

export interface TrustCopy {
  eyebrow: string
  title: string
  subtitle: string
  cards: TrustCard[]
  provenanceLabel: string
  provenance: ProvenanceStep[]
  statsLabel: string
  starsLabel: string
  contributorsLabel: string
  licenseLabel: string
  releasesLabel: string
  noReleasesYet: string
}

/**
 * One row of the closing "what you get today" index.
 *
 * `key` selects the value at render time — every one is derived from the
 * evidence snapshot or from copy already on the page, so the block states
 * nothing that is not verifiable elsewhere on the site.
 */
export type FinalCtaRowKey = "license" | "platforms" | "release" | "changes"

export interface FinalCtaRow {
  key: FinalCtaRowKey
  label: string
}

export interface FinalCtaCopy {
  eyebrow: string
  title: string
  support: string
  indexLabel: string
  rows: FinalCtaRow[]
  changesSuffix: string
}

/** The ten homepage section ids, in document order. */
export const HOME_SECTIONS = [
  "hero",
  "task",
  "workbench",
  "desktop",
  "entries",
  "run",
  "connections",
  "system",
  "trust",
  "start",
] as const

export type HomeSectionId = (typeof HOME_SECTIONS)[number]

/* -------------------------------------------------------------------------- */
/* Entry points: one task moving between devices                              */
/* -------------------------------------------------------------------------- */

/** The surfaces that reach one workspace, in the order the handoff visits them. */
export type EntryPointKey = "desktop" | "mobile" | "im" | "cli" | "browser"

export interface EntryPointStation {
  key: EntryPointKey
  name: string
  /** What this surface does with the task: runs it, approves it, receives it. */
  role: string
  body: string
}

/**
 * Labels inside the five miniature reconstructions. Values (repository,
 * branch, the checkpoint's command, the diff figures) come from `DEMO_TASK`
 * and the approval sheet reuses `ReconstructionCopy.artifacts.approval`.
 */
export interface EntryPointFramesCopy {
  desktop: { threadLabel: string; stateLabel: string }
  mobile: { heading: string }
  im: { sender: string; heading: string; filesLabel: string; notesLabel: string; replyHint: string }
  cli: { comment: string }
  browser: { heading: string; pageTitle: string; captureLabel: string; shortcutLabel: string }
}

export interface EntryPointsCopy {
  eyebrow: string
  title: string
  subtitle: string
  /** One sentence for assistive technology describing the whole sequence. */
  sequenceLabel: string
  stations: EntryPointStation[]
  frames: EntryPointFramesCopy
  channelsLabel: string
  /** Chat platforms with an adapter under `lib/connectors/adapters/`. */
  channels: string[]
  note: string
}

/* -------------------------------------------------------------------------- */
/* Capability panorama                                                        */
/* -------------------------------------------------------------------------- */

export type PanoramaLaneKey = "work" | "remember" | "reach" | "control"

export interface PanoramaItem {
  /** The bespoke mark for this subsystem, from `components/glyph.tsx`. */
  glyph: GlyphName
  name: string
  body: string
  /** Site route, when a page on this site covers it. */
  route?: string
  /** Docs path, when the documentation is the better next step. */
  docsPath?: string
}

export interface PanoramaLane {
  key: PanoramaLaneKey
  label: string
  claim: string
  items: PanoramaItem[]
}

export interface PanoramaCopy {
  eyebrow: string
  title: string
  subtitle: string
  figuresLabel: string
  /** One label per build-time figure, keyed by `InventoryKey`. */
  figures: Record<InventoryKey, string>
  figuresNote: string
  lanes: PanoramaLane[]
}

/* -------------------------------------------------------------------------- */
/* Magic UI composition copy                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The context-trace marquee between Hero and SignatureDemo. Each item
 * represents one context signal the agent consumed during the signature task.
 * Items source from `DEMO_TASK` values — the copy is the *label*, not the value.
 */
export interface ContextTraceCopy {
  items: Array<{ key: string; label: string }>
  /** Screen-reader heading for the marquee region. */
  srLabel: string
}

/**
 * Copy for the terminal sequence in the desktop section.
 * The actual command strings come from `DEMO_TASK`.
 */
export interface TerminalCopy {
  title: string
  playLabel: string
  pauseLabel: string
  restartLabel: string
  completeLabel: string
}

/**
 * Copy for the connection-flow animated beam diagram.
 */
export interface ConnectionFlowCopy {
  /** Accessible name for the SVG diagram region. */
  label: string
  /** Label for the central node. */
  centerNode: string
}

export interface HomeCopy {
  hero: HeroCopy
  signature: SignatureCopy
  workbench: WorkbenchCopy
  desktop: DesktopCopy
  /** One task moving between the desktop, a phone, chat, a terminal and the browser. */
  entryPoints: EntryPointsCopy
  run: RunCopy
  connections: ConnectionsCopy
  /** The whole instrument: build-time figures and every subsystem by lane. */
  panorama: PanoramaCopy
  trust: TrustCopy
  finalCta: FinalCtaCopy
  /**
   * Short labels for the reading-position rail, one per section id.
   *
   * Keyed by `HomeSectionId` so the rail's labels, the `id` each section
   * renders and this record are one fact rather than three that can drift.
   */
  sectionIndex: Record<HomeSectionId, string>
  /** The context-trace marquee between hero and signature task. */
  contextTrace: ContextTraceCopy
  /** Accessible name for the Lens inspection mode. */
  lensLabel: string
  /** Accessible name for the file-tree in the signature demo. */
  fileTreeLabel: string
  /** Copy for the terminal in the desktop section. */
  terminal: TerminalCopy
  /** Copy for the connection-flow animated beam diagram. */
  connectionFlow: ConnectionFlowCopy
}

/* -------------------------------------------------------------------------- */
/* Sub-pages                                                                   */
/* -------------------------------------------------------------------------- */

export interface PageHeader {
  eyebrow: string
  title: string
  subtitle: string
}

export interface CapabilityEntry {
  key: string
  name: string
  body: string
  /** Path on the docs site, locale prefix included by the caller. */
  docsPath?: string
}

export interface CapabilitySection {
  /**
   * Anchor id. Set wherever something links into the section — the navigation
   * dropdown and the footer both target `/product#chat` and friends, and a
   * section without an id would swallow those links silently.
   */
  id?: string
  title: string
  subtitle: string
  entries: CapabilityEntry[]
}

export interface FeatureShowcaseItem {
  key: string
  title: string
  body: string
  detail: string
  docsPath?: string
}

export interface FeatureShowcaseCopy {
  title: string
  subtitle: string
  items: FeatureShowcaseItem[]
}

export interface SystemFlowStep {
  key: string
  label: string
  body: string
  docsPath?: string
}

export interface SystemFlowCopy {
  title: string
  subtitle: string
  steps: SystemFlowStep[]
}

export interface ProductPageCopy {
  header: PageHeader
  /** Anchor ids must match the nav dropdown's targets. */
  sections: CapabilitySection[]
  showcase: FeatureShowcaseCopy
}

export interface WorkflowsPageCopy {
  header: PageHeader
  sections: CapabilitySection[]
  flow: SystemFlowCopy
  guarantees: RunnerGuaranteesCopy
}

export interface PluginsPageCopy {
  header: PageHeader
  sections: CapabilitySection[]
  flow: SystemFlowCopy
  authoring: { title: string; body: string; steps: string[] }
}

export interface TrustPageCopy {
  header: PageHeader
  sections: CapabilitySection[]
  flow: SystemFlowCopy
  evidence: {
    title: string
    subtitle: string
    rows: Array<{ claim: string; source: string; href?: string; docsPath?: string }>
    headings: { claim: string; source: string }
    /** Heading for the live figures strip that opens the section. */
    liveLabel: string
  }
}

export interface DownloadPageCopy {
  header: PageHeader
  showcase: FeatureShowcaseCopy
  buildFromSource: {
    title: string
    body: string
    steps: Array<{ label: string; command: string }>
  }
  requirements: { title: string; items: string[] }
  platformsTitle: string
  /**
   * Detected-platform hint beside the call to action. `CommonCopy.download`
   * already declares `detecting`, which until now nothing rendered.
   */
  platformHint: { label: string; unknown: string }
}

export interface UseCaseStep {
  rail: string
  title: string
  body: string
  detail: string
}

export interface UseCasePageCopy {
  header: PageHeader
  /** Explicit provenance line: is this dogfooding or a demo project? */
  provenance: string
  scriptTitle: string
  steps: UseCaseStep[]
  showcase: FeatureShowcaseCopy
  capabilities: CapabilitySection
  /** These pages carry no visual today; they get the workbench stage. */
  stageAlt: string
  stageCaption: string
}

export interface ChangelogPageCopy {
  header: PageHeader
  unreleasedTitle: string
  unreleasedNote: string
  releasedTitle: string
  emptyState: string
  bumpLabels: { major: string; minor: string; patch: string }
  entryCount: string
  /** Heading for the major/minor/patch proportion bar. */
  distributionLabel: string
  /** Accessible name for the sticky month rail. */
  monthIndexLabel: string
  /** Toggle on a folded entry. */
  expandEntry: string
  collapseEntry: string
  /** Button under a month showing only its first page of entries. `{count}` is the remainder. */
  showMoreEntries: string
}

/* -------------------------------------------------------------------------- */
/* Interface reconstructions (ADR-0092 §8)                                     */
/* -------------------------------------------------------------------------- */

/**
 * Prose for the DOM-rebuilt product surfaces. The technical strings they show —
 * paths, the diff body, commands, the branch — come from `demo-task.ts` and are
 * not translated; this is everything a reader has to be able to read in their
 * own language.
 *
 * `label` and `note` are not decoration. A rebuilt interface that does not say
 * it is rebuilt is a mock-up presented as a photograph of the product, which is
 * the one thing spec §3.4 and ADR-0092 §8 both refuse.
 */
export interface ReconstructionCopy {
  label: string
  note: string
  workbench: WorkbenchShellCopy
  desktop: DesktopShellCopy
  workflow: WorkflowShellCopy
  plugin: PluginShellCopy
  artifacts: TaskArtifactsCopy
}

/**
 * The workflow editor and its run ledger, rebuilt for the /workflows page.
 * Node titles come from the plan the signature task already carries, so the
 * graph is the same work the rest of the site follows, made repeatable.
 */
export interface WorkflowShellCopy {
  graphLabel: string
  /** The node that starts the graph when nobody is typing. */
  triggerLabel: string
  triggerName: string
  runsLabel: string
  /** Column headings of the run ledger. */
  runHeadings: { step: string; tool: string; state: string }
  /** Tag on the back-edge the live graph draws and refuses (validation rejects every cycle). */
  cycleRejectedLabel: string
}

/* -------------------------------------------------------------------------- */
/* Runner guarantees, demonstrated                                            */
/* -------------------------------------------------------------------------- */

export type NodeDemoState = "succeeded" | "failed" | "skipped" | "pending"

export interface RunnerGuaranteeDemosCopy {
  /** Eyebrow over the demonstration column. */
  label: string
  /** One execution path: the ways a run can start, all reaching one runner. */
  triggers: string[]
  runnerLabel: string
  recordLabel: string
  /** Cycles rejected on save: three node names and the tag the back-edge gets. */
  cycle: { nodes: string[]; attemptLabel: string; rejectedLabel: string }
  /** Depth bound: labels around the nesting counter (`workflowLabel` is the unit word). The limit itself is code. */
  depth: { label: string; limitLabel: string; workflowLabel: string }
  /** Every node recorded: a run in which one node fails and the rest never run. */
  states: {
    label: string
    items: Array<{ name: string; state: NodeDemoState }>
    stateLabels: Record<NodeDemoState, string>
  }
}

export interface RunnerGuaranteesCopy {
  title: string
  items: string[]
  demos: RunnerGuaranteeDemosCopy
}

/**
 * A plugin's declaration, rebuilt for the /plugins page from a manifest that
 * ships in the repository (`plugins/web-tools/plugin.json`).
 */
export interface PluginShellCopy {
  manifestLabel: string
  capabilitiesLabel: string
  permissionsLabel: string
  /** Heading over the call the runtime refused. */
  deniedLabel: string
  deniedNote: string
  grantedLabel: string
}

export interface WorkbenchShellCopy {
  /** Activity-rail entries, keyed by `DEMO_TASK.rail`. */
  rail: {
    chat: string
    agents: string
    workflows: string
    knowledge: string
    plugins: string
  }
  branchLabel: string
  threadLabel: string
  dockLabel: string
  tabs: { diff: string; artifact: string }
  /** The thread that opened the task, in order, with its speakers named. */
  youLabel: string
  userTurn: string
  agentLabel: string
  agentTurn: string
  toolCallLabel: string
  toolCallDetail: string
  statusLine: string
}

export interface DesktopShellCopy {
  paletteLabel: string
  paletteQuery: string
  paletteItems: string[]
  terminalLabel: string
  notificationLabel: string
  notificationTitle: string
  notificationBody: string
}

export interface ContextArtifactCopy {
  repositoryLabel: string
  branchLabel: string
  filesLabel: string
  /** Keyed by `DEMO_TASK.files[].key`. */
  fileNotes: { source: string; test: string; instructions: string }
  instructionsLabel: string
  instructions: string[]
}

export type PlanItemState = "done" | "active" | "todo"

export interface PlanArtifactCopy {
  heading: string
  toolLabel: string
  /** Keyed by `DEMO_TASK.plan[].key`. */
  items: {
    reproduce: { text: string; state: PlanItemState }
    fix: { text: string; state: PlanItemState }
    verify: { text: string; state: PlanItemState }
    notes: { text: string; state: PlanItemState }
  }
  stateLabels: { done: string; active: string; todo: string }
}

export interface DiffArtifactCopy {
  heading: string
  addedLabel: string
  removedLabel: string
  filesChangedLabel: string
  note: string
}

export interface ApprovalArtifactCopy {
  heading: string
  actionLabel: string
  targetLabel: string
  scopeLabel: string
  scope: string[]
  approveLabel: string
  denyLabel: string
  /** Says the controls are a depiction, so a dead button is never implied. */
  inertNote: string
}

export interface TestArtifactCopy {
  heading: string
  commandLabel: string
  /** Keyed by `DEMO_TASK.test.lines[].key`. */
  lineNotes: { discount: string; usd: string; jpy: string; rerun: string }
  stateLabels: { pass: string; fail: string; queued: string }
  summary: string
}

export interface ArtifactArtifactCopy {
  heading: string
  fileLabel: string
  versionLabel: string
  sections: Array<{ title: string; items: string[] }>
}

export interface TaskArtifactsCopy {
  context: ContextArtifactCopy
  plan: PlanArtifactCopy
  diff: DiffArtifactCopy
  approval: ApprovalArtifactCopy
  test: TestArtifactCopy
  artifact: ArtifactArtifactCopy
}

/* -------------------------------------------------------------------------- */

export interface SiteCopy {
  meta: MetaCopy
  nav: NavCopy
  footer: FooterCopy
  common: CommonCopy
  reconstruction: ReconstructionCopy
  home: HomeCopy
  product: ProductPageCopy
  workflows: WorkflowsPageCopy
  plugins: PluginsPageCopy
  trust: TrustPageCopy
  download: DownloadPageCopy
  useCases: {
    development: UseCasePageCopy
    research: UseCasePageCopy
  }
  changelog: ChangelogPageCopy
}
