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

/** The eight homepage section ids, in document order. */
export const HOME_SECTIONS = [
  "hero",
  "task",
  "workbench",
  "desktop",
  "run",
  "connections",
  "trust",
  "start",
] as const

export type HomeSectionId = (typeof HOME_SECTIONS)[number]

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
  run: RunCopy
  connections: ConnectionsCopy
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

export interface ProductPageCopy {
  header: PageHeader
  /** Anchor ids must match the nav dropdown's targets. */
  sections: CapabilitySection[]
}

export interface WorkflowsPageCopy {
  header: PageHeader
  sections: CapabilitySection[]
  guarantees: { title: string; items: string[] }
}

export interface PluginsPageCopy {
  header: PageHeader
  sections: CapabilitySection[]
  authoring: { title: string; body: string; steps: string[] }
}

export interface TrustPageCopy {
  header: PageHeader
  sections: CapabilitySection[]
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
  artifacts: TaskArtifactsCopy
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
