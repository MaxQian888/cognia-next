import type { SiteCopy } from "./types"

/**
 * English copy. Every factual claim here traces to something checkable in the
 * repository — the license file, a subsystem that ships, a documented ADR — per
 * the spec's content-governance rules. Words the spec bans (production-ready,
 * enterprise-grade, fully private, everything stays local, unlimited) do not
 * appear, and no number is written by hand: counts and versions come from the
 * build-time evidence pipelines.
 */
export const en: SiteCopy = {
  meta: {
    titleTemplate: "%s — Cognia",
    home: {
      title: "Cognia — Your open workspace for AI agents",
      description:
        "An open, desktop-first workspace for AI agents. Connect your models and tools, then plan, act and review every step in one workbench. Open source, AGPL-3.0-or-later.",
    },
    product: {
      title: "Product",
      description:
        "Chat, agents, workflows, knowledge and plugins share one working context. What each part of the workbench does, and where its documentation lives.",
    },
    workflows: {
      title: "Workflows",
      description:
        "Build a visual workflow, run it from chat, a schedule, or an agent, and see every node's state. One runner, cycle detection, a bounded nesting depth.",
    },
    plugins: {
      title: "Plugins",
      description:
        "Extend the workspace with plugins that declare the permissions they need. Panels, tools, workflow nodes and slash commands, all under an explicit capability catalog.",
    },
    trust: {
      title: "Trust",
      description:
        "Source, license, data boundaries, tool permissions and action records — what Cognia does with your work, and how to verify each claim yourself.",
    },
    download: {
      title: "Download",
      description:
        "Get Cognia for macOS, Windows or Linux, or build it from source. Desktop builds are produced by a signed release workflow.",
    },
    useCasesDevelopment: {
      title: "Development",
      description:
        "A reproducible end-to-end script: review a release, fix the failing check, prepare the launch notes — with Cognia, on Cognia's own repository.",
    },
    useCasesResearch: {
      title: "Research",
      description:
        "A reproducible end-to-end script for reading, extracting and keeping what you find: web reader, OCR, long-term memory and knowledge capture.",
    },
    changelog: {
      title: "Changelog",
      description:
        "Every change written for the people it affects, aggregated from the repository's changeset entries.",
    },
    surfaces: {
      title: "Surfaces",
      description:
        "The desktop runs the work. A paired phone, your chat platforms, a terminal and a browser extension reach the same workspace, each with only what you granted it.",
    },
  },

  nav: {
    brand: "Cognia",
    productMenu: {
      label: "Product",
      items: [
        {
          label: "Chat",
          route: "/product#chat",
          description: "One thread that carries plans, tools, approvals and artifacts.",
        },
        {
          label: "Agents",
          route: "/product#agents",
          description: "Named agents with their own tools, scope and review gates.",
        },
        {
          label: "Knowledge",
          route: "/product#knowledge",
          description: "Long-term memory, captured material and project context.",
        },
        {
          label: "Surfaces",
          route: "/surfaces",
          description: "Phone, chat, terminal and browser reaching the same workspace.",
        },
      ],
    },
    useCasesMenu: {
      label: "Use cases",
      items: [
        {
          label: "Software development",
          route: "/use-cases/development",
          description: "Review a release, fix the failing check, draft the notes.",
        },
        {
          label: "Research",
          route: "/use-cases/research",
          description: "Read sources, extract findings, keep every citation.",
        },
      ],
    },
    links: [
      { label: "Workflows", route: "/workflows" },
      { label: "Plugins", route: "/plugins" },
      { label: "Trust", route: "/trust" },
    ],
    docsLabel: "Docs",
    sourceLabel: "GitHub",
    downloadLabel: "Download",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    skipToContent: "Skip to content",
    switchLanguage: "Language",
    switchLanguageTo: "中文",
    themeToggle: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    sectionIndexLabel: "Sections on this page",
  },

  footer: {
    columns: [
      {
        title: "Product",
        links: [
          { label: "Chat", route: "/product#chat" },
          { label: "Agents", route: "/product#agents" },
          { label: "Knowledge", route: "/product#knowledge" },
          { label: "Surfaces", route: "/surfaces" },
          { label: "Workflows", route: "/workflows" },
          { label: "Plugins", route: "/plugins" },
        ],
      },
      {
        title: "Use cases",
        links: [
          { label: "Software development", route: "/use-cases/development" },
          { label: "Research", route: "/use-cases/research" },
        ],
      },
      {
        title: "Project",
        links: [
          { label: "Source", href: "https://github.com/MaxQian888/cognia-next" },
          {
            label: "License",
            href: "https://github.com/MaxQian888/cognia-next/blob/master/LICENSE",
          },
          { label: "Releases", href: "https://github.com/MaxQian888/cognia-next/releases" },
          { label: "Changelog", route: "/changelog" },
          {
            label: "Contributing",
            href: "https://github.com/MaxQian888/cognia-next/blob/master/CONTRIBUTING.md",
          },
        ],
      },
      {
        title: "Resources",
        links: [
          { label: "Docs", docsPath: "/docs" },
          { label: "Questions", route: "/#faq" },
          { label: "Trust", route: "/trust" },
          {
            label: "Security",
            href: "https://github.com/MaxQian888/cognia-next/blob/master/SECURITY.md",
          },
          { label: "Architecture", docsPath: "/docs/core/architecture" },
          { label: "Download", route: "/download" },
        ],
      },
    ],
    licenseLabel: "License",
    licenseNote: "AGPL-3.0-or-later",
    colophon: "Desktop first. Open source. Built for real work.",
  },

  common: {
    download: {
      available: "Download Cognia",
      availableFor: "Download for {platform}",
      unavailable: "Build from source",
      unavailableSecondary: "Watch releases",
      unavailableExplain:
        "No installer has been published yet. The build is public and reproducible — clone the repository and run the desktop build, or watch releases to be notified when the first one ships.",
      allPlatforms: "All platforms and checksums",
      version: "Version",
      published: "Published",
      platformMacos: "macOS",
      platformWindows: "Windows",
      platformLinux: "Linux",
      detecting: "Detecting your platform",
    },
    viewSource: "View source",
    readDocs: "Read the docs",
    asOf: "as of {date}",
    stale: "last successful read {date}",
    learnMore: "Read the docs",
    openPage: "Open the page",
    contextPathLabel: "Shared context path across the workbench",
    breadcrumbHome: "Home",
    onThisPage: "On this page",
    copyCommand: "Copy",
    copiedCommand: "Copied",
    pageClose: {
      eyebrow: "Try it",
      title: "Run it on your own machine.",
      body: "Clone the repository and build the desktop app. Every part this page names is documented in full.",
    },
  },

  footage: {
    captureNote: "Captured from the Cognia app running demo data.",
    recordingNote: "Recorded from the Cognia app running demo data.",
  },

  reconstruction: {
    label: "Interface reconstruction",
    note: "Rebuilt in this page from the same demo task, not a screenshot of the application.",
    workbench: {
      rail: {
        chat: "Chat",
        agents: "Agents",
        workflows: "Workflows",
        knowledge: "Knowledge",
        plugins: "Plugins",
      },
      branchLabel: "Branch",
      threadLabel: "Thread",
      dockLabel: "Workspace",
      tabs: { diff: "Diff", artifact: "Artifact" },
      youLabel: "You",
      userTurn: "Take the 2.4.0 release — fix the check that is failing, then draft the notes.",
      agentLabel: "Agent",
      agentTurn:
        "I read the release diff and the project instructions. The rounding helper is applied per order rather than per currency, which is what the check catches. Plan below.",
      toolCallLabel: "Tool call",
      toolCallDetail: "read 2 files · ran 1 check",
      statusLine: "Waiting for approval",
    },
    desktop: {
      paletteLabel: "Command palette",
      paletteQuery: "run check",
      paletteItems: ["Run project check", "Open integrated terminal", "Resume last task"],
      terminalLabel: "Integrated terminal",
      notificationLabel: "Notification",
      notificationTitle: "Task needs you",
      notificationBody: "The push to origin is waiting for confirmation.",
    },
    workflow: {
      graphLabel: "Workflow",
      triggerLabel: "Trigger",
      triggerName: "On schedule",
      runsLabel: "Runs",
      runHeadings: { step: "Step", tool: "Tool", state: "State" },
      cycleRejectedLabel: "Cycle rejected on save",
    },
    plugin: {
      manifestLabel: "Manifest",
      capabilitiesLabel: "Contributes",
      permissionsLabel: "Declares",
      deniedLabel: "Undeclared call",
      deniedNote: "Refused by the runtime before it ran.",
      grantedLabel: "Granted",
    },
    artifacts: {
      context: {
        repositoryLabel: "Repository",
        branchLabel: "Branch",
        filesLabel: "Read",
        fileNotes: {
          source: "The change under review",
          test: "The check that fails on it",
          instructions: "Conventions the project carries",
        },
        instructionsLabel: "Project instructions",
        instructions: [
          "Money is stored in minor units; never round to whole units.",
          "Every behaviour change ships with the test that would have caught it.",
          "Release notes are written from the merged changes, not from the branch name.",
        ],
      },
      plan: {
        heading: "Proposed plan",
        toolLabel: "Tool",
        items: {
          reproduce: { text: "Re-run the failing check and read the assertion", state: "done" },
          fix: { text: "Round per currency in the total helper", state: "done" },
          verify: { text: "Re-run the check against the changed files", state: "active" },
          notes: { text: "Draft the launch notes from the merged changes", state: "todo" },
        },
        stateLabels: { done: "Done", active: "In progress", todo: "Not started" },
      },
      diff: {
        heading: "Change under review",
        addedLabel: "added",
        removedLabel: "removed",
        filesChangedLabel: "files changed",
        note: "Shown in place and attributed to the step that produced it. Nothing has left the workspace yet.",
      },
      approval: {
        heading: "Checkpoint",
        actionLabel: "Action",
        targetLabel: "Target",
        scopeLabel: "This would allow",
        scope: [
          "Writing to a branch on the remote you configured",
          "Nothing outside the project directory",
          "No credential is read by the agent; the push uses your own git configuration",
        ],
        approveLabel: "Approve",
        denyLabel: "Deny",
        inertNote:
          "Depicted, not operable — the real checkpoint lives in the application and waits there.",
      },
      test: {
        heading: "Check output",
        commandLabel: "Command",
        lineNotes: {
          discount: "Unchanged by this edit",
          usd: "Unchanged by this edit",
          jpy: "The assertion the release failed on",
          rerun: "Queued behind the approval above",
        },
        stateLabels: { pass: "Passed", fail: "Failed", queued: "Queued" },
        summary: "The re-run is queued: the check runs after the push is confirmed.",
      },
      artifact: {
        heading: "Launch notes",
        fileLabel: "File",
        versionLabel: "Version",
        sections: [
          {
            title: "Fixed",
            items: [
              "Order totals round per currency, so zero-decimal currencies are no longer rounded twice.",
            ],
          },
          {
            title: "Still open",
            items: ["The re-run of the release check, pending the confirmation above."],
          },
        ],
      },
    },
    agents: {
      teamLabel: "Agent team",
      leadLabel: "Lead",
      members: [
        { name: "Lead", role: "Plans the review and merges results", state: "Awaiting approval" },
        { name: "Fixer", role: "Repairs the failing check", state: "Done" },
        { name: "Tester", role: "Re-runs the check", state: "Running" },
        { name: "Writer", role: "Drafts the launch notes", state: "Queued" },
      ],
      toolsLabel: "Tools",
      reviewLabel: "Review gate",
      reviewBody: "The lead reviews every teammate's change before the push is proposed.",
    },
    memory: {
      panelLabel: "Long-term memory",
      searchQuery: "checkout rounding",
      entries: [
        { text: "JPY has no minor units: round totals to whole yen.", state: "Kept" },
        { text: "Release branches are named release/<major>.<minor>.<patch>.", state: "Kept" },
        { text: "Launch notes for each release go in launch-notes.md.", state: "Awaiting review" },
      ],
      sourceLabel: "Source",
      pendingLabel: "Reviewed before it is kept",
    },
  },

  home: {
    film: {
      label: "Full recording · {seconds} s",
      lead: "The real app, start to finish: it reads the project, reproduces the failing check, shows the diff, passes the check, writes the notes — and stops before the push.",
      videoLabel:
        "Film: Cognia running the release task, from the request to the approval checkpoint on the push.",
      playLabel: "Play the film",
      captionsLabel: "English",
    },
    hero: {
      eyebrow: "Open-source AI workspace",
      title: "Your open workspace for AI agents.",
      subtitle:
        "Connect your models and tools. Plan, act, and review every step in one desktop workbench.",
      ticket: {
        label: "The task on this page",
        repositoryLabel: "Repository",
        branchLabel: "Branch",
        checkLabel: "Failing check",
        planLabel: "Plan",
        stateLabel: "State",
      },
      stageAlt:
        "The Cognia desktop workspace: a left activity rail, a chat thread showing an agent's plan, and a right-hand workbench holding the repository diff for the task in progress.",
      stageCaption: "The workspace running the task this page follows, end to end.",
    },

    signature: {
      eyebrow: "The task, recorded",
      title: "One task. Every step visible.",
      subtitle: "Plan, tools, approvals, tests, and artifacts stay in one reviewable thread.",
      taskLabel: "Task",
      task: "Review this release, fix the failing check, and prepare the launch notes.",
      steps: [
        {
          key: "context",
          artifact: "context",
          rail: "Context",
          status: "Context ready",
          tone: "ready",
          headline: "It reads the repository before it proposes anything.",
          body: "The agent opens the project, the diff under review and the instructions the project carries. What it read is listed, so you can tell whether it looked at the right thing.",
          detail: "repository · project instructions · release diff",
        },
        {
          key: "plan",
          artifact: "plan",
          rail: "Plan",
          status: "Plan approved",
          tone: "done",
          headline: "The plan is a document you approve, not a preamble.",
          body: "Steps, the tools each step needs, and what it will change. You can edit it, approve it, or send it back before a single file is touched.",
          detail: "4 steps · 2 tools · 1 write path",
        },
        {
          key: "action",
          artifact: "diff",
          rail: "Action",
          status: "Check fixed",
          tone: "done",
          headline: "The change arrives as a diff, not as a claim.",
          body: "Every edit is shown in place, attributed to the step that produced it, and reversible before anything leaves the workspace.",
          detail: "2 files changed · +18 −6",
        },
        {
          key: "approval",
          artifact: "approval",
          rail: "Approval",
          status: "Permission required",
          tone: "waiting",
          headline: "Anything that reaches outside stops here.",
          body: "Pushing a branch, calling an external tool, writing outside the project: each one is a checkpoint that names the action and waits for you.",
          detail: "awaiting confirmation · push to origin",
        },
        {
          key: "test",
          artifact: "test",
          rail: "Test",
          status: "Tests pending",
          tone: "pending",
          headline: "The check that failed is the check that has to pass.",
          body: "The agent re-runs the same check the release failed on, in the integrated terminal, with the output kept next to the change that caused it.",
          detail: "pnpm test --filter changed",
        },
        {
          key: "artifact",
          artifact: "artifact",
          rail: "Artifact",
          status: "Notes pending",
          tone: "pending",
          headline: "The result is a file you keep.",
          body: "Launch notes land as an artifact in the workspace — editable, versioned with the task that produced it, and exportable without a copy-paste round trip.",
          detail: "launch-notes.md",
        },
      ],
      stepperLabel: "Task steps",
      previousLabel: "Previous step",
      nextLabel: "Next step",
      playLabel: "Play",
      pauseLabel: "Pause",
      stepOf: "Step {current} of {total}",
      useCasesLabel: "The same loop, through a whole scenario",
      stepsLabel: "Or step through it at your own pace",
    },

    workbench: {
      eyebrow: "Your workbench",
      title: "Everything the task needs, in one workbench.",
      subtitle:
        "Chat, agents, workflows, knowledge and plugins are not five products with a shared login. They read and write the same working context.",
      panels: [
        {
          key: "task",
          label: "Agent task",
          body: "The task holds the plan, the steps, and the state each one reached.",
        },
        {
          key: "chat",
          label: "Chat & context",
          body: "The thread that started it, with the files and instructions it was given.",
        },
        {
          key: "artifact",
          label: "Artifact",
          body: "What the task produced, kept in the workspace rather than in a message.",
        },
        {
          key: "workflow",
          label: "Workflow",
          body: "The repeatable version of the same work, runnable on a schedule.",
        },
        {
          key: "knowledge",
          label: "Knowledge",
          body: "What the workspace remembers between tasks, and where it came from.",
        },
        {
          key: "plugins",
          label: "Plugins",
          body: "The tools this task is allowed to call, and what each one may touch.",
        },
      ],
    },

    desktop: {
      eyebrow: "Desktop first",
      title: "A workspace that stays close to the work.",
      subtitle:
        "The work is on your machine: the files, the terminal, the repository and the tools. The workspace runs there too.",
      capabilities: [
        {
          label: "Files and projects",
          body: "Open a real project directory. The agent reads and writes the same files you do.",
        },
        {
          label: "Integrated terminal and editor",
          body: "Run the check, read the output, edit the file — without leaving the task.",
        },
        {
          label: "System entry points",
          body: "Reach the workspace from a shortcut, and let long tasks report back through notifications.",
        },
        {
          label: "Long-running tasks",
          body: "Work that takes minutes keeps running while you do something else.",
        },
        {
          label: "Local actions that ask first",
          body: "Anything touching your machine outside the project names itself and waits.",
        },
      ],
      stageAlt:
        "A close crop of the Cognia desktop app: every check has passed, the launch notes are drafted, and the approval to push release/2.4.0 is waiting for you.",
      otherSurfaces: {
        label: "Also reaches this workspace",
        linkLabel: "See every surface",
      },
    },

    run: {
      eyebrow: "Run it your way",
      title: "Choose the model. See the boundary.",
      subtitle:
        "Different work deserves different runtimes. Each option states what leaves your device, who receives it, and what needs your confirmation.",
      headings: {
        strategy: "Strategy",
        leaves: "What leaves the device",
        receives: "Who receives it",
        tools: "Tools it can call",
        approval: "Needs confirmation",
      },
      strategies: [
        {
          key: "local",
          name: "Local runtime",
          summary: "A model served from your own machine or a service you operate.",
          leaves: "Nothing, when the endpoint is on your machine",
          receives: "The runtime you configured",
          tools: "The tools you grant the session",
          docsPath: "/docs/chat/provider-system",
        },
        {
          key: "byok",
          name: "Bring your own key",
          summary: "Your provider account and your credentials, held in the system keychain.",
          leaves: "The prompt and the context you attach to it",
          receives: "The provider you chose",
          tools: "The tools you grant the session",
          docsPath: "/docs/chat/provider-system",
        },
        {
          key: "subscription",
          name: "Existing subscription",
          summary: "Reuse a coding subscription you already pay for, through its own sign-in.",
          leaves: "The prompt and the context you attach to it",
          receives: "The subscription's provider",
          tools: "The tools that subscription's agent supports",
          docsPath: "/docs/chat/claude-subscription-oauth",
        },
        {
          key: "fallback",
          name: "Fallback and routing",
          summary:
            "A second model takes over when the first is rate-limited or unavailable, on rules you set.",
          leaves: "The same context, to whichever route is selected",
          receives: "The next provider in your route",
          tools: "Unchanged by the switch",
          docsPath: "/docs/chat/provider-system",
        },
      ],
      approvalShared:
        "Writes outside the project, and any external call. The same under every strategy, and unchanged when a fallback switches models.",
      agents: {
        label: "Agent interop",
        note: "Run these agents inside the workspace over ACP, or import their existing session history. Each runs with the tools and permissions you grant it, and its steps land in the same reviewable thread.",
        runLabel: "Run",
        importLabel: "Import history",
        items: [
          { id: "claude-code", name: "Claude Code", run: true, import: true },
          { id: "codex", name: "Codex", run: true, import: true },
          { id: "gemini-cli", name: "Gemini CLI", run: true, import: true },
          { id: "opencode", name: "OpenCode", run: true, import: true },
          { id: "cursor", name: "Cursor CLI", run: true, import: false },
          { id: "copilot", name: "Copilot CLI", run: true, import: false },
          { id: "qwen", name: "Qwen Code", run: true, import: false },
          { id: "kiro", name: "Kiro", run: true, import: false },
          { id: "aider", name: "Aider", run: false, import: true },
          { id: "continue", name: "Continue", run: false, import: true },
        ],
      },
    },

    trust: {
      eyebrow: "Trust receipts",
      title: "Built in the open. Controlled in use.",
      subtitle: "Source, data, permission and record: each one you can check yourself.",
      cards: [
        {
          key: "source",
          label: "Source",
          body: "The whole application is public and licensed AGPL-3.0-or-later — including the parts that talk to your files, your keys and your models.",
          linkLabel: "Read the source",
          href: "https://github.com/MaxQian888/cognia-next",
        },
        {
          key: "data",
          label: "Data",
          body: "Where your work is stored, what a model call carries, and which runtime receives it — stated per option rather than as one promise.",
          linkLabel: "Data and storage",
          route: "/trust",
        },
        {
          key: "permission",
          label: "Permission",
          body: "Tools declare the capabilities they need. Anything that reaches outside the project stops and names the action before it runs.",
          linkLabel: "Permission model",
          route: "/trust",
        },
        {
          key: "record",
          label: "Record",
          body: "Steps, tool calls, approvals and results stay attached to the task that produced them, so a result can be traced back or undone.",
          linkLabel: "How records work",
          route: "/trust",
        },
      ],
      statsLabel: "From the repository",
      starsLabel: "Stars",
      contributorsLabel: "Contributors",
      licenseLabel: "License",
      releasesLabel: "Latest release",
      noReleasesYet: "None published yet",
    },

    faq: {
      eyebrow: "Questions",
      title: "What people ask before they install it.",
      items: [
        {
          key: "price",
          question: "Is Cognia free?",
          answer:
            "Yes. The whole application is open source under AGPL-3.0-or-later, and there is no paid tier in the repository. If you pay for anything, it is the model you connect: a provider key, a subscription you already have, or nothing at all for a local runtime.",
          link: {
            label: "Read the license",
            href: "https://github.com/MaxQian888/cognia-next/blob/master/LICENSE",
          },
        },
        {
          key: "install",
          question: "Can I install it today?",
          answer:
            "The download page always shows the current state: an installer for your platform once a release is published, and until then the steps to build the desktop app from source on macOS, Windows or Linux.",
          link: { label: "Open the download page", route: "/download" },
        },
        {
          key: "models",
          question: "Which models can I use?",
          answer:
            "Cloud providers with your own key, such as OpenAI, Anthropic, Google, DeepSeek, OpenRouter and Bedrock; subscriptions you already pay for; or local runtimes such as Ollama and LM Studio. Keys are kept in your operating system's keyring.",
          link: { label: "Provider documentation", docsPath: "/docs/chat/provider-system" },
        },
        {
          key: "data",
          question: "Where does my data live?",
          answer:
            "On your machine. Conversations and workspace data are stored by the app locally, and search vectors in a SQLite file in its data directory. What leaves is what you send to the model you chose and the tools you approve. Account sync is optional, end-to-end encrypted, and still in beta.",
          link: { label: "Storage documentation", docsPath: "/docs/data/storage" },
        },
        {
          key: "agents",
          question: "Does it work with the coding agent I already use?",
          answer:
            "Claude Code, Codex, Gemini CLI, OpenCode and others run inside the workspace through ACP or a dedicated adapter, and sessions from several of them can be imported. The run section above marks which agent supports which.",
          link: { label: "External agents", docsPath: "/docs/chat/external-agents" },
        },
        {
          key: "surfaces",
          question: "Do the phone, chat and browser need the desktop app?",
          answer:
            "Yes. The desktop runs the work. A paired phone, your chat platforms, the terminal and the browser extension reach the same workspace, and each holds only the permissions you granted it.",
          link: { label: "See every surface", route: "/surfaces" },
        },
        {
          key: "contribute",
          question: "How do I report a problem or contribute?",
          answer:
            "Open an issue or a pull request on GitHub. The contributing guide covers the setup, and security reports follow the security policy rather than the public tracker.",
          link: {
            label: "Contributing guide",
            href: "https://github.com/MaxQian888/cognia-next/blob/master/CONTRIBUTING.md",
          },
        },
      ],
    },
    finalCta: {
      eyebrow: "Start here",
      title: "Bring your agents into one open workspace.",
      support: "License, platforms and release state, each checkable in the repository.",
      indexLabel: "What you get today",
      rows: [
        { key: "platforms", label: "Builds on" },
        { key: "release", label: "Latest release" },
        { key: "changes", label: "Changes waiting" },
      ],
      changesSuffix: "entries recorded, not yet released",
      buildLabel: "Build it from source",
    },

    sectionIndex: {
      hero: "Overview",
      task: "One task",
      workbench: "Workbench",
      desktop: "Desktop",
      run: "Run",
      trust: "Trust",
      faq: "Questions",
      start: "Start",
    },
    lensLabel: "Inspect product interface",
    fileTreeLabel: "Repository file tree",
    terminal: {
      title: "Terminal",
      playLabel: "Play",
      pauseLabel: "Pause",
      restartLabel: "Restart",
      completeLabel: "Terminal sequence complete",
      awaitingLabel: "waiting for your approval",
    },
  },

  product: {
    header: {
      eyebrow: "Product",
      title: "One workspace, four parts, one working context.",
      subtitle:
        "Each surface below is a real part of the application. Every entry links to the documentation that describes how it actually behaves.",
    },
    sections: [
      {
        id: "chat",
        title: "Chat",
        subtitle:
          "The thread is where a task starts and where its record stays. It carries plans, tool calls, approvals and the files involved.",
        entries: [
          {
            key: "chat",
            name: "Threads that hold the work",
            body: "A conversation keeps the plan, the diffs, the approvals and the artifacts it produced, instead of scattering them across messages.",
            docsPath: "/docs/chat/chat-and-skills",
          },
          {
            key: "slash",
            name: "Slash commands and skills",
            body: "Named commands run repeatable work from the composer, with the same permission rules as anything else.",
            docsPath: "/docs/chat/slash-commands",
          },
          {
            key: "providers",
            name: "Provider system",
            body: "Local runtimes, your own keys, an existing subscription, and routing rules for when one is unavailable.",
            docsPath: "/docs/chat/provider-system",
          },
        ],
      },
      {
        id: "agents",
        title: "Agents",
        subtitle:
          "Agents are named, scoped and reviewable. They carry their own tools and their own gates rather than inheriting everything.",
        entries: [
          {
            key: "agents",
            name: "Agent teams",
            body: "Several agents on one task, each with a role, with a lead that reviews before work merges.",
            docsPath: "/docs/chat/agent-teams",
          },
          {
            key: "execution",
            name: "Unified execution",
            body: "One execution path for built-in and external agents, so behaviour does not change with the backend.",
            docsPath: "/docs/subsystems/unified-agent-execution",
          },
          {
            key: "external",
            name: "External agents",
            body: "Run agent backends you already use, hosted by the workspace rather than replaced by it.",
            docsPath: "/docs/chat/external-agents",
          },
        ],
      },
      {
        id: "knowledge",
        title: "Knowledge",
        subtitle:
          "What the workspace remembers between tasks, where each piece came from, and how to remove it.",
        entries: [
          {
            key: "memory",
            name: "Long-term memory",
            body: "Durable notes with their source attached, surfaced when a task needs them rather than injected everywhere.",
            docsPath: "/docs/subsystems/long-term-memory",
          },
          {
            key: "capture",
            name: "Knowledge capture",
            body: "Bring in pages, documents and screenshots, and keep the extraction next to the original.",
            docsPath: "/docs/subsystems/knowledge-capture",
          },
          {
            key: "storage",
            name: "Local storage and search",
            body: "Where the workspace keeps things on disk, and how search reaches them.",
            docsPath: "/docs/data/storage",
          },
        ],
      },
      {
        id: "desktop",
        title: "Desktop",
        subtitle: "The parts that only exist because the workspace runs on your machine.",
        entries: [
          {
            key: "terminal",
            name: "Integrated terminal",
            body: "Run the command, keep the output attached to the task that needed it.",
            docsPath: "/docs/subsystems/integrated-terminal",
          },
          {
            key: "ide",
            name: "Editor and Pro IDE",
            body: "Read and edit project files in place, with a full editor when the change is bigger than a diff.",
            docsPath: "/docs/subsystems/pro-ide",
          },
          {
            key: "scm",
            name: "Source control",
            body: "Stage, review and commit from the workspace, with the diff the agent produced in front of you.",
            docsPath: "/docs/subsystems/source-control",
          },
        ],
      },
    ],
    figureCaptions: {
      chat: "The thread on the signature task: plan, tool calls and the checkpoint in one column.",
      agents: "An agent team on the same task, each member with its own tools and one review gate.",
      knowledge: "What the task left behind, each entry with the file it came from.",
      desktop: "The command palette, terminal and notification of the desktop shell.",
    },
    panorama: {
      eyebrow: "The whole instrument",
      title: "One codebase. Every part in the open.",
      subtitle:
        "Every subsystem on one of four lanes: work, remember, reach and control, each linked to where it is explained.",
      lanes: [
        {
          key: "work",
          label: "Work",
          claim: "Where a task is planned and run.",
          items: [
            {
              glyph: "chat",
              name: "Chat",
              body: "The thread that starts a task, with the files, mentions and instructions it was given.",
              route: "/product#chat",
            },
            {
              glyph: "agents",
              name: "Agent tasks",
              body: "A plan you approve, steps with the tools each one needs, and the state each reached.",
              route: "/product#agents",
            },
            {
              glyph: "squads",
              name: "Squads",
              body: "Several agents on one task, with roles, a shared record and one place to review their work.",
              docsPath: "/docs/chat/agent-teams",
            },
            {
              glyph: "workflows",
              name: "Workflows",
              body: "The repeatable version of work already done once, drawn as a graph and run on a trigger.",
              route: "/workflows",
            },
            {
              glyph: "scheduler",
              name: "Scheduler",
              body: "Tasks and workflows on a calendar, with a ledger of every run and what it produced.",
              route: "/workflows#run",
            },
            {
              glyph: "tasks",
              name: "Background runs",
              body: "Work that takes minutes keeps going while you do something else, and reports back.",
              route: "/product#desktop",
            },
          ],
        },
        {
          key: "remember",
          label: "Remember",
          claim: "What the workspace keeps between tasks.",
          items: [
            {
              glyph: "knowledge",
              name: "Knowledge and repo wiki",
              body: "Documents, a generated wiki of the repository, and cited search over both.",
              route: "/product#knowledge",
            },
            {
              glyph: "memory",
              name: "Long-term memory",
              body: "Facts the workspace learned, reviewable before they are kept and traceable to their source.",
              route: "/product#knowledge",
            },
            {
              glyph: "canvas",
              name: "Artifacts and canvas",
              body: "What a task produced, kept as a versioned file in the workspace rather than in a message.",
              route: "/product#agents",
            },
            {
              glyph: "ocr",
              name: "OCR",
              body: "Text lifted from screenshots, scans and PDFs, on the machine, before it reaches a model.",
              docsPath: "/docs/subsystems/ocr",
            },
          ],
        },
        {
          key: "reach",
          label: "Reach",
          claim: "What it can touch, and on what terms.",
          items: [
            {
              glyph: "plugins",
              name: "Plugins",
              body: "WebAssembly, TypeScript and Python plugins that declare every capability they use.",
              route: "/plugins",
            },
            {
              glyph: "mcp",
              name: "MCP servers",
              body: "Tools exposed by any MCP server, granted per session and confirmed on first use.",
              route: "/plugins#surfaces",
            },
            {
              glyph: "connectors",
              name: "Chat connectors",
              body: "Inbound messages and outbound reports over the platforms listed above.",
              route: "/product#desktop",
            },
            {
              glyph: "browser",
              name: "Browser companion",
              body: "An extension that sends a page you chose into a task, and nothing it did not ask for.",
              docsPath: "/docs/subsystems/companion-api",
            },
            {
              glyph: "computerUse",
              name: "Computer use",
              body: "The agent drives applications on your desktop, each action visible and interruptible.",
              docsPath: "/docs/subsystems/computer-use",
            },
          ],
        },
        {
          key: "control",
          label: "Control",
          claim: "How every action stays accountable.",
          items: [
            {
              glyph: "permissions",
              name: "Permission model",
              body: "Tools declare what they touch. Anything that reaches outside the project stops and names itself.",
              route: "/trust#permission",
            },
            {
              glyph: "receipts",
              name: "Traces and cost",
              body: "Every call, token and tool result recorded against the task that made it.",
              route: "/trust#data",
            },
            {
              glyph: "sourceControl",
              name: "Source control",
              body: "Diffs, commits and stacked branches from inside the workspace, pushed only when you say.",
              route: "/product#desktop",
            },
            {
              glyph: "terminal",
              name: "Integrated terminal",
              body: "Real shells beside the thread, shareable to a paired device with the roster in view.",
              route: "/product#desktop",
            },
          ],
        },
      ],
    },
  },

  workflows: {
    header: {
      eyebrow: "Workflows",
      title: "The repeatable version of work you have already done once.",
      subtitle:
        "A workflow is a graph you can read: nodes with declared inputs, edges you can follow, and a state on every run.",
    },
    sections: [
      {
        id: "build",
        title: "Build",
        subtitle: "A visual editor over a typed graph, not a diagram that has to be kept in sync.",
        entries: [
          {
            key: "editor",
            name: "Visual editor",
            body: "Add nodes, connect them, and see what each one receives. The graph is the definition, not a picture of it.",
            docsPath: "/docs/subsystems/visual-workflows",
          },
          {
            key: "nodes",
            name: "Nodes from plugins",
            body: "Plugins contribute workflow nodes under the same capability declarations they use everywhere else.",
            docsPath: "/docs/adr/0017-workflow-plugin-extension-points",
          },
        ],
      },
      {
        id: "run",
        title: "Run",
        subtitle: "The same runner, whether the trigger is you, a schedule, or an agent.",
        entries: [
          {
            key: "runner",
            name: "One runner",
            body: "Chat, scheduler and agent triggers all execute through the same path, so a workflow behaves the same however it starts.",
            docsPath: "/docs/subsystems/visual-workflows",
          },
          {
            key: "scheduler",
            name: "Scheduled runs",
            body: "Run on a schedule and have the result reported back, including when it fails.",
            docsPath: "/docs/subsystems/scheduler",
          },
        ],
      },
    ],
    flow: {
      title: "From event to evidence.",
      subtitle:
        "A workflow is more than the graph on the canvas. The same typed definition carries its trigger, execution policy, and inspectable result.",
      steps: [
        {
          key: "trigger",
          label: "Trigger",
          body: "Start manually, from chat, on a schedule, through a connector, or from another workflow without changing the definition.",
          docsPath: "/docs/subsystems/visual-workflows/triggers-rust",
        },
        {
          key: "graph",
          label: "Typed graph",
          body: "Declared node inputs and outputs make invalid edges visible before a run begins and keep the canvas aligned with the saved definition.",
          docsPath: "/docs/subsystems/visual-workflows/data-model",
        },
        {
          key: "execution",
          label: "Controlled execution",
          body: "The runtime resolves dependencies, applies depth and cycle limits, and carries one execution context through every eligible node.",
          docsPath: "/docs/subsystems/visual-workflows/runtime-execution",
        },
        {
          key: "record",
          label: "Run record",
          body: "Inputs, outputs, timing, errors, and skipped nodes remain available as one run you can inspect and retry from the workspace.",
          docsPath: "/docs/subsystems/visual-workflows/ui-runs",
        },
      ],
    },
    guarantees: {
      title: "What the runner guarantees",
      items: [
        "One execution path — a workflow behaves identically whether a person, a schedule or an agent starts it.",
        "Cycles are rejected when the graph is saved, not discovered at run time.",
        "Nesting is depth-bounded, so a workflow calling a workflow cannot recurse forever.",
        "Every node's state is recorded, including the ones that never ran.",
      ],
      demos: {
        label: "Each guarantee, shown",
        triggers: ["Manual", "Chat", "Schedule", "Connector", "Workflow"],
        runnerLabel: "One runner",
        recordLabel: "The same run record",
        cycle: {
          nodes: ["Read", "Fix", "Verify"],
          attemptLabel: "Back-edge",
          rejectedLabel: "Rejected on save",
        },
        depth: { label: "Nesting depth", limitLabel: "Limit", workflowLabel: "levels" },
        states: {
          label: "Node states, one run",
          items: [
            { name: "Fetch the release", state: "succeeded" },
            { name: "Run the check", state: "failed" },
            { name: "Open the pull request", state: "skipped" },
            { name: "Post the summary", state: "skipped" },
          ],
          stateLabels: {
            succeeded: "Succeeded",
            failed: "Failed",
            skipped: "Skipped",
            pending: "Pending",
          },
        },
      },
    },
  },

  plugins: {
    header: {
      eyebrow: "Plugins",
      title: "Extend the workspace without widening what it may do.",
      subtitle:
        "A plugin declares the Cognia capabilities it needs in its manifest. Undeclared Cognia APIs are denied, and you can read the declaration before installing.",
    },
    sections: [
      {
        id: "surfaces",
        title: "What a plugin can contribute",
        subtitle: "Surfaces a plugin can add, each under the same permission rules.",
        entries: [
          {
            key: "tools",
            name: "Tools",
            body: "New tools an agent may call, with the capabilities they need spelled out.",
            docsPath: "/docs/subsystems/plugin-system",
          },
          {
            key: "panels",
            name: "Panels and views",
            body: "Their own surfaces inside the workspace, next to the task they belong to.",
            docsPath: "/docs/subsystems/plugin-system",
          },
          {
            key: "nodes",
            name: "Workflow nodes",
            body: "Steps other people's workflows can use, contributed the same way as tools.",
            docsPath: "/docs/adr/0017-workflow-plugin-extension-points",
          },
          {
            key: "commands",
            name: "Slash commands",
            body: "Named entry points in the composer for work the plugin knows how to do.",
            docsPath: "/docs/chat/slash-commands",
          },
        ],
      },
      {
        id: "capabilities",
        title: "How permission works",
        subtitle: "The declaration is the contract, and it is enforced rather than advertised.",
        entries: [
          {
            key: "manifest",
            name: "Declared capabilities",
            body: "The manifest lists every capability. Requesting one outside the list fails rather than prompting.",
            docsPath: "/docs/subsystems/plugin-system",
          },
          {
            key: "signing",
            name: "Signing and provenance",
            body: "Where a plugin came from, and what that means for what it is allowed to do.",
            docsPath: "/docs/plugins/plugin-signing",
          },
          {
            key: "sandbox",
            name: "Host-page execution",
            body: "Plugin bundles currently execute in the host page through indirect eval. Capability checks constrain Cognia APIs, but ambient browser globals remain available; this is not a code-isolation sandbox.",
            docsPath: "/docs/subsystems/sandbox",
          },
        ],
      },
    ],
    connections: {
      eyebrow: "Connections with consequences",
      title: "Connect tools without losing the task.",
      subtitle:
        "A connection is only useful if you can say what it reads, what it may do, and when it has to ask.",
      headings: {
        reads: "Reads",
        canAct: "Can act",
        requiresApproval: "Requires approval",
      },
      items: [
        {
          key: "repository",
          name: "Repository",
          reads: "Code, issues and the diff under review",
          canAct: "Propose a branch, a commit, a pull request",
          requiresApproval: "Anything pushed to the remote",
        },
        {
          key: "mcp",
          name: "MCP tool",
          reads: "The inputs you pass to the call",
          canAct: "Run the tool the server exposes",
          requiresApproval: "First use, and any call marked sensitive",
        },
        {
          key: "plugin",
          name: "Plugin",
          reads: "Only the capabilities its manifest declares",
          canAct: "Produce or update an artifact in the workspace",
          requiresApproval: "Every capability outside its declared set",
        },
        {
          key: "im",
          name: "Chat and notifications",
          reads: "The messages addressed to it",
          canAct: "Report progress and ask for a decision",
          requiresApproval: "Acting on a reply that changes anything",
        },
      ],
      catalogueNote:
        "The full provider, MCP, plugin and connector catalogs live in the documentation rather than on this page.",
    },
    connectionFlow: {
      label: "How Cognia connects to external systems",
      centerNode: "Cognia",
    },
    flow: {
      title: "From existing capability to installed extension.",
      subtitle:
        "A skill, MCP server, CLI, or purpose-built bundle can enter through the same manifest-driven lifecycle and surface only what it declares.",
      steps: [
        {
          key: "source",
          label: "Bring the source",
          body: "Start from the SDK or adapt an existing skill, MCP server, or CLI. Impeccable follows this path as an installable design-review skill.",
          docsPath: "/docs/subsystems/plugin-system/agent-sdk",
        },
        {
          key: "contract",
          label: "Declare the contract",
          body: "The manifest names activation events, bundled resources, contribution points, and every Cognia capability the extension may request.",
          docsPath: "/docs/subsystems/plugin-system/contracts-and-registries",
        },
        {
          key: "surfaces",
          label: "Contribute surfaces",
          body: "Register skills, tools, commands, panels, workflow nodes, hooks, or providers through the host bridges instead of patching the application.",
          docsPath: "/docs/subsystems/plugin-system/bridges",
        },
        {
          key: "package",
          label: "Package and install",
          body: "Build a versioned archive, validate its contents, install it locally, and let Cognia activate or remove it through one lifecycle.",
          docsPath: "/docs/subsystems/plugin-system/packaging-and-lifecycle",
        },
      ],
    },
    authoring: {
      title: "Writing one",
      body: "The plugin CLI scaffolds, builds and packages a plugin, and can convert an existing MCP server, skill or CLI into one without writing plugin code.",
      steps: [
        "Scaffold the plugin and declare the capabilities it needs.",
        "Build the surfaces it contributes — tools, panels, workflow nodes, commands.",
        "Package it, and install it locally to check the declaration against what it actually calls.",
      ],
    },
  },

  trust: {
    header: {
      eyebrow: "Trust",
      title: "Every claim on this site, and where to check it.",
      subtitle:
        "Open source is a property you can verify, not a badge. This page lists what Cognia does with your work and points at the artefact that proves each statement.",
    },
    sections: [
      {
        id: "data",
        title: "Data boundaries",
        subtitle: "Where your work lives, and what a model call actually carries.",
        entries: [
          {
            key: "storage",
            name: "Local storage",
            body: "Conversations, artifacts, memory and settings are stored on your machine. The documentation describes the schema and the location.",
            docsPath: "/docs/data/storage",
          },
          {
            key: "backup",
            name: "Backup and export",
            body: "Your data can be exported and restored in a documented format — the test for whether it is really yours.",
            docsPath: "/docs/data/backup-and-data",
          },
          {
            key: "model",
            name: "What reaches a model",
            body: "A call carries the prompt and the context attached to it, to the runtime you chose. The provider documentation states which one that is.",
            docsPath: "/docs/chat/provider-system",
          },
        ],
      },
      {
        id: "permission",
        title: "Permission and record",
        subtitle: "What stops before it acts, and what remains afterwards.",
        entries: [
          {
            key: "approval",
            name: "Approval checkpoints",
            body: "Actions that leave the project — pushing, calling an external tool, writing elsewhere on disk — name themselves and wait.",
            docsPath: "/docs/subsystems/unified-agent-execution",
          },
          {
            key: "capabilities",
            name: "Capability declarations",
            body: "Plugins and tools can only reach what their manifest declares, and the catalog of capabilities is public.",
            docsPath: "/docs/subsystems/plugin-system",
          },
          {
            key: "sandbox",
            name: "Execution model",
            body: "Plugin bundles execute in the host page through indirect eval. Declared capabilities gate Cognia APIs, but ambient browser globals remain available.",
            docsPath: "/docs/subsystems/sandbox",
          },
        ],
      },
    ],
    flow: {
      title: "A task crosses named boundaries.",
      subtitle:
        "The useful question is not whether an AI workspace is abstractly safe. It is where data lives, what leaves, which action waits, and what remains to inspect.",
      steps: [
        {
          key: "local",
          label: "Local workspace",
          body: "Threads, settings, memory, artifacts, and project state begin in the desktop workspace and its documented local stores.",
          docsPath: "/docs/data/storage",
        },
        {
          key: "runtime",
          label: "Selected runtime",
          body: "Only the prompt and attached context needed for a call go to the local or remote model runtime selected for that task.",
          docsPath: "/docs/chat/provider-system",
        },
        {
          key: "approval",
          label: "Approval boundary",
          body: "A gated tool action describes its target and waits at the boundary before it changes external state.",
          docsPath: "/docs/subsystems/unified-agent-execution",
        },
        {
          key: "record",
          label: "Durable record",
          body: "Tool events, agent traces, errors, and run timing stay attributable to the task so behavior can be reviewed after execution.",
          docsPath: "/docs/subsystems/observability",
        },
      ],
    },
    evidence: {
      title: "Claim and source",
      subtitle:
        "Nothing in this table is maintained by hand. Each row points at the artefact the claim is read from.",
      headings: { claim: "Claim", source: "Source" },
      liveLabel: "Live figures",
      rows: [
        {
          claim: "The application is licensed AGPL-3.0-or-later",
          source: "LICENSE in the repository",
          href: "https://github.com/MaxQian888/cognia-next/blob/master/LICENSE",
        },
        {
          claim: "The source is public and complete",
          source: "The repository itself",
          href: "https://github.com/MaxQian888/cognia-next",
        },
        {
          claim: "Desktop builds are produced by a signed workflow",
          source: "The release workflow in the repository",
          href: "https://github.com/MaxQian888/cognia-next/blob/master/.github/workflows/release.yml",
        },
        {
          claim: "Published releases and supported platforms",
          source: "GitHub Releases, read at build time",
          href: "https://github.com/MaxQian888/cognia-next/releases",
        },
        {
          claim: "How each subsystem behaves",
          source: "The architecture decision records",
          docsPath: "/docs/adr/0092-official-website-workspace",
        },
      ],
    },
  },

  download: {
    header: {
      eyebrow: "Download",
      title: "Run it on your own machine.",
      subtitle:
        "Cognia is a desktop application. When a release is published, the installers below come from a signed build of the public source.",
    },
    showcase: {
      title: "Why the workbench runs on your machine.",
      subtitle:
        "The desktop shell is not packaging around a web page. It is what lets one task reach local projects, native services, portable data, and another authenticated device.",
      items: [
        {
          key: "shell",
          title: "Native desktop shell",
          body: "A Tauri host connects the static interface to Rust services for files, processes, automation, and platform integration through explicit commands.",
          detail: "Tauri · Rust services · command bridge",
          docsPath: "/docs/core/runtime-and-tauri",
        },
        {
          key: "project",
          title: "Project tools in place",
          body: "Use the integrated terminal, editor, source control, and project instructions against the files already on your machine.",
          detail: "Terminal · editor · source control",
          docsPath: "/docs/subsystems/integrated-terminal",
        },
        {
          key: "data",
          title: "Portable local data",
          body: "Export and restore conversations, settings, memory, and artifacts through a documented backup format instead of depending on an account silo.",
          detail: "Backup · restore · export",
          docsPath: "/docs/data/backup-and-data",
        },
        {
          key: "companion",
          title: "Connected companion",
          body: "Reach the running desktop workspace from an authenticated companion device through the same service plane and explicit connection controls.",
          detail: "Companion · authentication · live session",
          docsPath: "/docs/subsystems/companion-api",
        },
      ],
    },
    buildFromSource: {
      title: "Build from source",
      body: "The desktop build is reproducible from the repository. This is the same path the release workflow takes.",
      steps: [
        {
          label: "Clone the repository",
          command: "git clone https://github.com/MaxQian888/cognia-next",
        },
        { label: "Install dependencies", command: "pnpm install" },
        { label: "Build the desktop application", command: "pnpm tauri build" },
      ],
    },
    requirements: {
      title: "What you need",
      items: [
        "Node.js and pnpm, to install dependencies and build the frontend.",
        "A Rust toolchain, because the desktop shell is compiled rather than bundled.",
        "A model to talk to: a local runtime, a provider key, or a subscription you already have.",
      ],
    },
    platformsTitle: "Platforms",
    platformHint: { label: "Detected", unknown: "Platform not detected" },
  },

  surfaces: {
    header: {
      eyebrow: "Surfaces",
      title: "Start at the desk. Decide from anywhere.",
      subtitle:
        "The desktop runs the work. Every other surface reaches the same thread and holds only what that device was granted.",
    },
    entryPoints: {
      eyebrow: "One task, five stops",
      title: "Follow one task from the desk to your pocket and back.",
      subtitle:
        "The task lives on your machine. The desktop runs it, and your phone, the chat platform you already use, a terminal and the browser all reach the same thread, each with only the authority you gave that device.",
      sequenceLabel:
        "How one task moves between devices: started on the desktop, approved from the phone, reported in chat, resumed from the terminal, and fed a page from the browser.",
      stations: [
        {
          key: "desktop",
          name: "Desktop",
          role: "Runs the task",
          body: "macOS, Windows and Linux. The files, the terminal and the agent are on the same machine.",
        },
        {
          key: "mobile",
          name: "Phone",
          role: "Approves the checkpoint",
          body: "The paired iOS or Android app shows the approval that is waiting, and nothing the pairing did not grant.",
        },
        {
          key: "im",
          name: "Chat",
          role: "Receives the result",
          body: "Progress and questions arrive where you already are. A reply that would change anything still asks first.",
        },
        {
          key: "cli",
          name: "Command line",
          role: "Resumes the session",
          body: "The same agent loop as the desktop, from a shell, picking up the session where it left off.",
        },
        {
          key: "browser",
          name: "Browser",
          role: "Adds a page",
          body: "The companion extension captures a page you chose and hands it to the workspace over a paired, loopback-only channel.",
        },
      ],
      frames: {
        desktop: { threadLabel: "Thread", stateLabel: "State" },
        mobile: { heading: "Approval waiting" },
        im: {
          sender: "Cognia",
          heading: "Check fixed",
          filesLabel: "files changed",
          notesLabel: "Launch notes drafted",
          replyHint: "Reply to decide the next step",
        },
        cli: { comment: "resume the most recent session" },
        browser: {
          heading: "Browser companion",
          pageTitle: "Rounding rules for zero-decimal currencies",
          captureLabel: "Capture page",
          shortcutLabel: "Shortcut",
        },
      },
      channelsLabel: "Chat platforms with an adapter in the repository",
      channels: [
        "Telegram",
        "Slack",
        "Discord",
        "Lark",
        "DingTalk",
        "WeCom",
        "WeChat Official Accounts",
        "WeChat",
        "Matrix",
        "OneBot",
        "QQ",
      ],
      note: "Every surface above is rebuilt in this page from the same demo task.",
    },
    sections: [
      {
        id: "desktop",
        title: "Desktop",
        subtitle:
          "The machine that runs the work: files, terminal, repositories and agents together.",
        entries: [
          {
            key: "platforms",
            name: "macOS, Windows and Linux",
            body: "One codebase builds the desktop shell for all three, with the same workspace on each.",
            docsPath: "/docs/core/runtime-and-tauri",
          },
          {
            key: "tray",
            name: "Tray panel",
            body: "Running work and pending approvals at a glance from the menu bar, without opening the window.",
            docsPath: "/docs/subsystems/tray-panel",
          },
          {
            key: "terminal",
            name: "Integrated terminal",
            body: "A real shell beside the thread, which you can share with a paired device and revoke at any time.",
            docsPath: "/docs/subsystems/integrated-terminal",
          },
        ],
      },
      {
        id: "mobile",
        title: "Phone",
        subtitle:
          "iOS and Android apps paired to your desktop, built from this repository like the desktop app. They follow, approve and reply; the desktop still runs the work.",
        entries: [
          {
            key: "pair",
            name: "Pair by QR code",
            body: "Scan a code on the desktop. The invitation expires, and the connection runs over WebRTC, through a relay only when the two networks cannot meet directly.",
            docsPath: "/docs/ui/mobile-architecture/discovery-pairing",
          },
          {
            key: "approve",
            name: "Approve checkpoints",
            body: "A tool call waiting for you shows up on the phone with what it would run and where. Approve or deny it there.",
            docsPath: "/docs/subsystems/remote-control",
          },
          {
            key: "follow",
            name: "Follow the thread",
            body: "Read and reply in the conversation, stop a run, or open a terminal the desktop has shared with this phone.",
            docsPath: "/docs/ui/mobile-architecture",
          },
        ],
      },
      {
        id: "im",
        title: "Chat platforms",
        subtitle:
          "Progress and questions arrive where you already talk, through the adapters that ship in the repository.",
        entries: [
          {
            key: "deliver",
            name: "Results where you are",
            body: "A finished task, a question or a checkpoint is posted to the channel you connected, linked to its thread.",
            docsPath: "/docs/subsystems/platform-connectors",
          },
          {
            key: "gate",
            name: "Replies that act still ask",
            body: "Inbound messages pass a gate first. A reply that would change something waits for the same approval as on the desktop.",
            docsPath: "/docs/subsystems/platform-connectors/inbound-gating",
          },
          {
            key: "cards",
            name: "Cards, not walls of text",
            body: "Assistant surfaces are projected into each platform's own rich messages, and button presses route back to the task.",
            docsPath: "/docs/subsystems/platform-connectors/ai-and-a2ui",
          },
        ],
      },
      {
        id: "cli",
        title: "Command line",
        subtitle:
          "cognia-agent runs the same agent loop in a shell, for the work that starts there.",
        entries: [
          {
            key: "resume",
            name: "Pick up where you stopped",
            body: "cognia-agent chat --continue resumes the most recent session in the terminal you are in.",
            docsPath: "/docs/subsystems/cognia-agent-tui",
          },
          {
            key: "handoff",
            name: "Hand a session to the desktop",
            body: "cognia-agent handoff copies a terminal session into the running desktop app, so it continues with the full workbench.",
            docsPath: "/docs/subsystems/cli-app-bridge",
          },
          {
            key: "tooling",
            name: "Plugin tooling",
            body: "A separate cognia command scaffolds, lints and signs plugins from the same repository.",
            docsPath: "/docs/subsystems/cognia-cli",
          },
        ],
      },
      {
        id: "browser",
        title: "Browser",
        subtitle:
          "An extension for Chrome and Edge that hands pages to the workspace over a loopback-only channel.",
        entries: [
          {
            key: "capture",
            name: "Capture a page",
            body: "Send the page, a selection or the article text to a task with a keyboard shortcut you can change.",
            docsPath: "/docs/subsystems/companion-api",
          },
          {
            key: "panel",
            name: "Side panel",
            body: "Talk to the workspace from the browser's side panel without leaving the page you are reading.",
            docsPath: "/docs/subsystems/companion-api",
          },
          {
            key: "scope",
            name: "Asks only when you pair",
            body: "Access to the local desktop is requested at pairing, not on install, and the extension does not run in private windows.",
            docsPath: "/docs/subsystems/companion-api/server-and-auth",
          },
        ],
      },
    ],
    flow: {
      title: "Every surface follows one lifecycle.",
      subtitle:
        "Pairing a device is a grant, not a login. It can be read, narrowed and taken back.",
      steps: [
        {
          key: "pair",
          label: "Pair",
          body: "The desktop issues a short-lived invitation; the device redeems it once.",
          docsPath: "/docs/ui/mobile-architecture/discovery-pairing",
        },
        {
          key: "grant",
          label: "Grant",
          body: "The device receives named capabilities, never the desktop's full reach.",
          docsPath: "/docs/subsystems/companion-api/server-and-auth",
        },
        {
          key: "reach",
          label: "Reach",
          body: "Every request it makes is checked against that grant and recorded under the task.",
          docsPath: "/docs/subsystems/companion-api",
        },
        {
          key: "revoke",
          label: "Revoke",
          body: "Forget the device on the desktop and its next request is refused.",
          docsPath: "/docs/subsystems/remote-control",
        },
      ],
    },
  },

  inventory: {
    figuresLabel: "Counted at build time",
    figures: {
      plugins: "In-tree plugins",
      connectors: "Chat platform adapters",
      workflowNodeKinds: "Workflow node kinds",
      crates: "Rust crates",
      packages: "Workspace packages",
      adrs: "Recorded design decisions",
      testFiles: "Test files",
    },
    figuresNote:
      "Directory listings and file counts over the checkout. Any of them can be reproduced with a single ls.",
  },

  useCases: {
    development: {
      header: {
        eyebrow: "Use case · Development",
        title: "Review the release, fix the check, write the notes.",
        subtitle:
          "The task this whole site follows, run on a real codebase — the one Cognia is built in.",
      },
      provenance:
        "This script is dogfooding: it describes how Cognia's own repository is worked on, using Cognia. It is not a customer story and contains no performance claims.",
      scriptTitle: "The script, step by step",
      stageAlt:
        "The Cognia workbench running this script: the thread that carries the task on the left, and the workspace holding what it produced on the right.",
      stageCaption: "The same workbench, running the script on this page.",
      showcase: {
        title: "Four systems keep the change reviewable.",
        subtitle:
          "The visible script is backed by context selection, coordinated execution, local verification, and artifacts that stay with the repository.",
        items: [
          {
            key: "context",
            title: "Repository-aware context",
            body: "Project instructions, selected files, diffs, and captured references become an explicit context set the agent can inspect before acting.",
            detail: "Instructions · files · diff",
            docsPath: "/docs/ui/context-workbench",
          },
          {
            key: "teams",
            title: "Agent teams",
            body: "Delegate bounded parts of a release task to named roles while a lead keeps shared state and synthesizes the result.",
            detail: "Roles · delegation · synthesis",
            docsPath: "/docs/chat/agent-teams",
          },
          {
            key: "terminal",
            title: "Terminal evidence",
            body: "Run the repository's own checks locally and retain command output beside the step and file change it verifies.",
            detail: "Commands · output · verification",
            docsPath: "/docs/subsystems/integrated-terminal",
          },
          {
            key: "artifacts",
            title: "Versioned artifacts",
            body: "Plans, launch notes, generated files, and diffs remain editable workspace artifacts before they become commits or exports.",
            detail: "Plans · notes · diffs",
            docsPath: "/docs/subsystems/artifacts-sandbox",
          },
        ],
      },
      steps: [
        {
          rail: "Context",
          title: "Point it at the change, not at the codebase",
          body: "Open the project and hand the agent the diff under review plus the instructions the repository carries. It states what it read before it proposes anything.",
          detail: "project · diff · repository instructions",
        },
        {
          rail: "Plan",
          title: "Read the plan before any file moves",
          body: "The plan names the steps, the tools each one needs and the paths it will write. Edit it or send it back; nothing has been touched yet.",
          detail: "plan approved",
        },
        {
          rail: "Action",
          title: "Take the fix as a diff",
          body: "The change appears in place, attributed to the step that produced it, reversible in the workspace before it goes anywhere.",
          detail: "files changed in the workspace",
        },
        {
          rail: "Approval",
          title: "Stop at the boundary",
          body: "Pushing the branch is a checkpoint. The action is named, and it waits for a person.",
          detail: "push to origin · awaiting confirmation",
        },
        {
          rail: "Test",
          title: "Re-run the check that failed",
          body: "The integrated terminal runs the same check the release failed on, and the output stays attached to the change that caused it.",
          detail: "the project's own test command",
        },
        {
          rail: "Artifact",
          title: "Keep the notes as a file",
          body: "The launch notes land as an artifact in the workspace, versioned with the task, ready to edit or export.",
          detail: "launch-notes.md",
        },
      ],
      capabilities: {
        title: "What this uses",
        subtitle: "Every capability in the script above, and where it is documented.",
        entries: [
          {
            key: "scm",
            name: "Source control",
            body: "Reading the diff, staging the fix, and stopping before the push.",
            docsPath: "/docs/subsystems/source-control",
          },
          {
            key: "terminal",
            name: "Integrated terminal",
            body: "Running the failing check with the output kept next to the change.",
            docsPath: "/docs/subsystems/integrated-terminal",
          },
          {
            key: "agents",
            name: "Agent execution",
            body: "The plan, the steps, and the approval checkpoints between them.",
            docsPath: "/docs/subsystems/unified-agent-execution",
          },
        ],
      },
    },

    research: {
      header: {
        eyebrow: "Use case · Research",
        title: "Read it, extract it, and still have it next month.",
        subtitle:
          "Reading is only half of research. This script is about what survives after the tab is closed.",
      },
      provenance:
        "This script uses capabilities that ship today — reading, extraction, capture and memory. It describes what the tools do, not what a researcher achieved with them.",
      scriptTitle: "The script, step by step",
      stageAlt:
        "The Cognia workbench running this script: the thread that carries the task on the left, and the workspace holding what it produced on the right.",
      stageCaption: "The same workbench, running the script on this page.",
      showcase: {
        title: "From raw source to reusable knowledge.",
        subtitle:
          "Cognia keeps the original material, the extraction, the memory, and the repeatable collection path connected instead of collapsing them into one answer.",
        items: [
          {
            key: "capture",
            title: "Source-preserving capture",
            body: "Bring in pages, documents, and screenshots as workspace items while retaining the origin next to derived text and notes.",
            detail: "Source · snapshot · provenance",
            docsPath: "/docs/subsystems/knowledge-capture",
          },
          {
            key: "ocr",
            title: "OCR and extraction",
            body: "Route images and scanned pages through local or configured OCR providers and keep recognized text attached to its source.",
            detail: "Images · PDFs · recognized text",
            docsPath: "/docs/subsystems/ocr",
          },
          {
            key: "memory",
            title: "Searchable memory",
            body: "Promote selected findings into durable memory with provenance, then retrieve them when a later task makes them relevant.",
            detail: "Memory · retrieval · provenance",
            docsPath: "/docs/subsystems/long-term-memory",
          },
          {
            key: "repeat",
            title: "Repeatable collection",
            body: "Turn the collection path into a visual workflow, schedule it, and inspect each run without rebuilding the research procedure.",
            detail: "Workflow · schedule · run history",
            docsPath: "/docs/subsystems/visual-workflows",
          },
        ],
      },
      steps: [
        {
          rail: "Collect",
          title: "Bring the material in",
          body: "Pages, documents and screenshots enter the workspace as captured items, with the original kept next to whatever was extracted from it.",
          detail: "captured item · source retained",
        },
        {
          rail: "Read",
          title: "Turn a page into text you can work with",
          body: "The reader extracts the readable content, so the material can be quoted and checked rather than summarised away.",
          detail: "extracted content",
        },
        {
          rail: "Extract",
          title: "Pull text out of what is not text",
          body: "Screenshots and scanned documents go through OCR, and the recognised text stays attached to the image it came from.",
          detail: "OCR result · linked to source",
        },
        {
          rail: "Keep",
          title: "Decide what is worth remembering",
          body: "Findings become durable memory with their source recorded, surfaced later when a task needs them rather than injected into everything.",
          detail: "memory entry · source recorded",
        },
        {
          rail: "Reuse",
          title: "Make the reading repeatable",
          body: "When the same collection has to happen again, the steps become a workflow that can run on a schedule and report what it found.",
          detail: "workflow · scheduled run",
        },
      ],
      capabilities: {
        title: "What this uses",
        subtitle: "Every capability in the script above, and where it is documented.",
        entries: [
          {
            key: "capture",
            name: "Knowledge capture",
            body: "Getting pages, documents and screenshots into the workspace with their origin intact.",
            docsPath: "/docs/subsystems/knowledge-capture",
          },
          {
            key: "ocr",
            name: "OCR",
            body: "Recognising text in images and scans, kept attached to the source.",
            docsPath: "/docs/subsystems/ocr",
          },
          {
            key: "memory",
            name: "Long-term memory",
            body: "Durable notes with provenance, retrieved when relevant.",
            docsPath: "/docs/subsystems/long-term-memory",
          },
          {
            key: "workflows",
            name: "Workflows",
            body: "Turning the collection pass into something that runs again on its own.",
            docsPath: "/docs/subsystems/visual-workflows",
          },
        ],
      },
    },
  },

  changelog: {
    header: {
      eyebrow: "Changelog",
      title: "What changed, written for the people it affects.",
      subtitle:
        "Each entry is recorded alongside the change that caused it, so this page is generated from the repository rather than remembered afterwards.",
    },
    unreleasedTitle: "Unreleased",
    unreleasedNote:
      "These changes are merged and awaiting the first tagged release. Each entry was written when the change was made.",
    releasedTitle: "Released",
    emptyState: "No entries yet.",
    bumpLabels: { major: "Breaking", minor: "Feature", patch: "Fix" },
    entryCount: "{count} entries",
    distributionLabel: "By bump",
    monthIndexLabel: "Jump to a month",
    expandEntry: "Read the full entry",
    collapseEntry: "Show less",
    showMoreEntries: "Show {count} more",
  },
}
