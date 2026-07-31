import type { SiteCopy } from "./types"

/**
 * Chinese copy. Structurally identical to `en` by construction — a missing or
 * extra key fails `pnpm typecheck` rather than degrading at runtime.
 *
 * Product screenshots on Chinese pages are captured against the application's
 * Chinese interface (ADR-0092 §8), so the alt text below describes what a
 * Chinese-locale reader actually sees.
 */
export const zh: SiteCopy = {
  meta: {
    titleTemplate: "%s — Cognia",
    home: {
      title: "Cognia — 你的开放 AI Agent 工作空间",
      description:
        "一个开放的、桌面优先的 AI Agent 工作空间。连接自己的模型与工具，在一个工作台中计划、执行并审阅每一步。开源，AGPL-3.0-or-later。",
    },
    product: {
      title: "产品",
      description:
        "对话、Agent、工作流、知识与插件共享同一份工作上下文。工作台的每一部分做什么，文档在哪里。",
    },
    workflows: {
      title: "工作流",
      description:
        "搭一条可视化工作流，从对话、定时或 Agent 触发运行，并看到每个节点的状态。单一执行器、环检测、有界嵌套深度。",
    },
    plugins: {
      title: "插件",
      description:
        "用声明了所需权限的插件扩展工作空间。面板、工具、工作流节点与斜杠命令，全部受同一份能力清单约束。",
    },
    trust: {
      title: "信任",
      description:
        "源码、许可证、数据边界、工具权限与行动记录——Cognia 对你的工作做了什么，以及每一条你要如何自己核验。",
    },
    download: {
      title: "下载",
      description:
        "获取 macOS、Windows 或 Linux 版 Cognia，或从源码构建。桌面产物由带签名的发布流程产出。",
    },
    useCasesDevelopment: {
      title: "开发",
      description:
        "一条可复现的端到端剧本：审阅这次发布、修好失败的检查、准备发布说明——用 Cognia，在 Cognia 自己的仓库上。",
    },
    useCasesResearch: {
      title: "研究",
      description:
        "一条关于「读进来、抽出来、留得住」的可复现剧本：网页阅读、OCR、长期记忆与知识捕获。",
    },
    changelog: {
      title: "变更日志",
      description: "每一条变更都写给它影响的人，由仓库里的 changeset 条目聚合而成。",
    },
  },

  nav: {
    brand: "Cognia",
    productMenu: {
      label: "产品",
      items: [
        {
          label: "对话",
          route: "/product#chat",
          description: "一条线程承载计划、工具调用、审批与产物。",
        },
        {
          label: "Agent",
          route: "/product#agents",
          description: "有名字的 Agent，各自带着自己的工具、边界与审阅关卡。",
        },
        {
          label: "知识",
          route: "/product#knowledge",
          description: "长期记忆、捕获的材料与项目上下文。",
        },
      ],
    },
    links: [
      { label: "工作流", route: "/workflows" },
      { label: "插件", route: "/plugins" },
      { label: "信任", route: "/trust" },
    ],
    docsLabel: "文档",
    sourceLabel: "GitHub",
    downloadLabel: "下载",
    openMenu: "打开菜单",
    closeMenu: "关闭菜单",
    skipToContent: "跳到主要内容",
    switchLanguage: "语言",
    switchLanguageTo: "English",
    themeToggle: "主题",
    themeLight: "浅色",
    themeDark: "深色",
    themeSystem: "跟随系统",
    sectionIndexLabel: "本页章节",
  },

  footer: {
    columns: [
      {
        title: "产品",
        links: [
          { label: "对话", route: "/product#chat" },
          { label: "Agent", route: "/product#agents" },
          { label: "工作流", route: "/workflows" },
          { label: "知识", route: "/product#knowledge" },
          { label: "插件", route: "/plugins" },
        ],
      },
      {
        title: "项目",
        links: [
          { label: "源码", href: "https://github.com/MaxQian888/cognia-next" },
          {
            label: "许可证",
            href: "https://github.com/MaxQian888/cognia-next/blob/master/LICENSE",
          },
          { label: "发布", href: "https://github.com/MaxQian888/cognia-next/releases" },
          { label: "变更日志", route: "/changelog" },
          {
            label: "参与贡献",
            href: "https://github.com/MaxQian888/cognia-next/blob/master/CONTRIBUTING.md",
          },
        ],
      },
      {
        title: "资源",
        links: [
          { label: "文档", docsPath: "/docs" },
          { label: "信任", route: "/trust" },
          {
            label: "安全",
            href: "https://github.com/MaxQian888/cognia-next/blob/master/SECURITY.md",
          },
          { label: "架构", docsPath: "/docs/core/architecture" },
          { label: "下载", route: "/download" },
        ],
      },
    ],
    licenseLabel: "许可证",
    licenseNote: "AGPL-3.0-or-later",
    colophon: "桌面优先。开源。为真实工作而建。",
  },

  common: {
    download: {
      available: "下载 Cognia",
      availableFor: "下载 {platform} 版",
      unavailable: "从源码构建",
      unavailableSecondary: "关注发布",
      unavailableExplain:
        "目前还没有发布安装包。构建过程是公开且可复现的——克隆仓库跑一次桌面构建，或关注发布，等第一个版本出来时收到通知。",
      allPlatforms: "全部平台与校验和",
      version: "版本",
      published: "发布于",
      platformMacos: "macOS",
      platformWindows: "Windows",
      platformLinux: "Linux",
      detecting: "正在识别你的平台",
    },
    viewSource: "查看源码",
    readDocs: "阅读文档",
    asOf: "数据截至 {date}",
    stale: "上次成功读取 {date}",
    learnMore: "了解更多",
    contextPathLabel: "贯穿工作台的共享上下文路径",
    breadcrumbHome: "首页",
    onThisPage: "本页内容",
    copyCommand: "复制",
    copiedCommand: "已复制",
  },

  reconstruction: {
    label: "界面结构重建",
    note: "由本页基于同一条演示任务重建，不是应用截图。",
    workbench: {
      rail: {
        chat: "对话",
        agents: "Agent",
        workflows: "工作流",
        knowledge: "知识",
        plugins: "插件",
      },
      branchLabel: "分支",
      threadLabel: "线程",
      dockLabel: "工作空间",
      tabs: { diff: "Diff", artifact: "产物" },
      youLabel: "你",
      userTurn: "看一下 2.4.0 这次发布——修好正在失败的那个检查，然后起草说明。",
      agentLabel: "Agent",
      agentTurn:
        "我读了发布 diff 和项目说明。取整助手是按订单调用的，而不是按币种，这正是检查抓到的问题。计划如下。",
      toolCallLabel: "工具调用",
      toolCallDetail: "读取 2 个文件 · 运行 1 次检查",
      statusLine: "等待审批",
    },
    desktop: {
      paletteLabel: "命令面板",
      paletteQuery: "运行检查",
      paletteItems: ["运行项目检查", "打开集成终端", "继续上一个任务"],
      terminalLabel: "集成终端",
      notificationLabel: "通知",
      notificationTitle: "任务需要你",
      notificationBody: "推送到 origin 正在等待确认。",
    },
    artifacts: {
      context: {
        repositoryLabel: "仓库",
        branchLabel: "分支",
        filesLabel: "已读取",
        fileNotes: {
          source: "待审阅的改动",
          test: "在它上面失败的检查",
          instructions: "项目自带的约定",
        },
        instructionsLabel: "项目说明",
        instructions: [
          "金额以最小货币单位存储；绝不要取整到整数单位。",
          "每个行为改动都要附带能抓住它的那个测试。",
          "发布说明依据已合并的改动撰写，而不是依据分支名。",
        ],
      },
      plan: {
        heading: "提议的计划",
        toolLabel: "工具",
        items: {
          reproduce: { text: "重跑失败的检查并读断言", state: "done" },
          fix: { text: "在总额助手里按币种取整", state: "done" },
          verify: { text: "针对改动文件重跑检查", state: "active" },
          notes: { text: "依据已合并的改动起草发布说明", state: "todo" },
        },
        stateLabels: { done: "已完成", active: "进行中", todo: "未开始" },
      },
      diff: {
        heading: "待审阅的改动",
        addedLabel: "新增",
        removedLabel: "删除",
        filesChangedLabel: "个文件改动",
        note: "就地展示，并归属到产出它的那一步。目前还没有任何东西离开工作空间。",
      },
      approval: {
        heading: "确认点",
        actionLabel: "动作",
        targetLabel: "目标",
        scopeLabel: "这将允许",
        scope: [
          "向你配置的远端上的一个分支写入",
          "不涉及项目目录之外的任何位置",
          "Agent 不读取任何凭据；推送使用你自己的 git 配置",
        ],
        approveLabel: "批准",
        denyLabel: "拒绝",
        inertNote: "此处仅为示意，不可操作——真正的确认点在应用内等待。",
      },
      test: {
        heading: "检查输出",
        commandLabel: "命令",
        lineNotes: {
          discount: "本次改动未触及",
          usd: "本次改动未触及",
          jpy: "发布失败时的那条断言",
          rerun: "排在上面的审批之后",
        },
        stateLabels: { pass: "通过", fail: "失败", queued: "排队中" },
        summary: "重跑在排队：推送确认之后才会运行这次检查。",
      },
      artifact: {
        heading: "发布说明",
        fileLabel: "文件",
        versionLabel: "版本",
        sections: [
          {
            title: "已修复",
            items: ["订单总额按币种取整，零小数位币种不再被取整两次。"],
          },
          {
            title: "仍未完成",
            items: ["发布检查的重跑，取决于上面的确认。"],
          },
        ],
      },
    },
  },

  home: {
    hero: {
      eyebrow: "开源 AI 工作空间",
      title: "你的开放 AI Agent 工作空间。",
      subtitle: "连接自己的模型与工具，在一个桌面工作台中计划、执行并审阅每一步。",
      trustRail: [
        { label: "开源", detail: "AGPL-3.0-or-later，仓库公开" },
        { label: "自带模型", detail: "本地运行时、自己的密钥、自己的订阅" },
        { label: "受权限约束的动作", detail: "工具声明它会碰什么，由你确认" },
        { label: "桌面优先", detail: "本地文件、终端、长时间任务" },
      ],
      ticket: {
        label: "本页跟随的任务",
        repositoryLabel: "仓库",
        branchLabel: "分支",
        checkLabel: "失败的检查",
        planLabel: "计划",
        stateLabel: "状态",
      },
      stageAlt:
        "Cognia 桌面工作空间：左侧活动栏，中间是展示 Agent 计划的对话线程，右侧工作台里是当前任务的仓库 diff。",
      stageCaption: "这个工作空间正在跑的，就是本页从头到尾跟随的那条任务。",
    },

    signature: {
      eyebrow: "一条任务，从头到尾",
      title: "一条任务。每一步都看得见。",
      subtitle: "计划、工具、审批、测试与产物，留在同一条可审阅的线程里。",
      taskLabel: "任务",
      task: "审阅这次发布，修好失败的检查，并准备发布说明。",
      steps: [
        {
          key: "context",
          artifact: "context",
          rail: "上下文",
          status: "上下文就绪",
          tone: "ready",
          headline: "它先读仓库，再提方案。",
          body: "Agent 打开项目、待审阅的 diff，以及项目自带的说明。它读了什么会被列出来，因此你能判断它有没有看对地方。",
          detail: "仓库 · 项目说明 · 发布 diff",
        },
        {
          key: "plan",
          artifact: "plan",
          rail: "计划",
          status: "计划已批准",
          tone: "done",
          headline: "计划是一份你要批准的文档，不是一段开场白。",
          body: "步骤、每一步需要的工具、以及它将改动什么。你可以编辑、批准或打回——在此之前没有任何文件被碰过。",
          detail: "4 步 · 2 个工具 · 1 条写入路径",
        },
        {
          key: "action",
          artifact: "diff",
          rail: "执行",
          status: "检查已修复",
          tone: "done",
          headline: "改动以 diff 的形式出现，而不是一句声称。",
          body: "每一处编辑都在原位展示、归属到产生它的那一步，并且在离开工作空间之前都可以撤销。",
          detail: "2 个文件改动 · +18 −6",
        },
        {
          key: "approval",
          artifact: "approval",
          rail: "审批",
          status: "需要授权",
          tone: "waiting",
          headline: "任何伸向外部的动作都停在这里。",
          body: "推送分支、调用外部工具、写到项目之外：每一项都是一个检查点，会说清自己要做什么，然后等你。",
          detail: "等待确认 · 推送到 origin",
        },
        {
          key: "test",
          artifact: "test",
          rail: "测试",
          status: "测试待运行",
          tone: "pending",
          headline: "当初失败的那个检查，就是必须通过的那个。",
          body: "Agent 在集成终端里重跑发布时失败的同一个检查，输出就留在造成它的那处改动旁边。",
          detail: "pnpm test --filter changed",
        },
        {
          key: "artifact",
          artifact: "artifact",
          rail: "产物",
          status: "说明待生成",
          tone: "pending",
          headline: "结果是一份你留得下的文件。",
          body: "发布说明作为产物落在工作空间里——可编辑、与产生它的任务一起留痕，不用复制粘贴就能导出。",
          detail: "launch-notes.md",
        },
      ],
      stepperLabel: "任务步骤",
      previousLabel: "上一步",
      nextLabel: "下一步",
      playLabel: "播放",
      pauseLabel: "暂停",
      stepOf: "第 {current} 步，共 {total} 步",
    },

    workbench: {
      eyebrow: "你的工作台",
      title: "任务需要的一切，在同一个工作台里。",
      subtitle:
        "对话、Agent、工作流、知识与插件不是五个共用登录态的产品。它们读写同一份工作上下文。",
      panels: [
        {
          key: "task",
          label: "Agent 任务",
          body: "任务持有计划、步骤，以及每一步走到了哪个状态。",
        },
        { key: "chat", label: "对话与上下文", body: "发起它的那条线程，连同交给它的文件与说明。" },
        {
          key: "artifact",
          label: "产物",
          body: "任务产出的东西，留在工作空间里，而不是留在一条消息里。",
        },
        { key: "workflow", label: "工作流", body: "同一件事的可重复版本，可以按计划定时运行。" },
        { key: "knowledge", label: "知识", body: "工作空间在任务之间记住的东西，以及它们的来源。" },
        {
          key: "plugins",
          label: "插件",
          body: "这条任务被允许调用的工具，以及每个工具可以碰什么。",
        },
      ],
    },

    desktop: {
      eyebrow: "桌面优先",
      title: "一个贴着工作本身的工作空间。",
      subtitle: "工作在你的机器上：文件、终端、仓库、工具。工作空间也在。",
      capabilities: [
        { label: "文件与项目", body: "打开一个真实的项目目录。Agent 读写的就是你读写的那些文件。" },
        { label: "集成终端与编辑器", body: "跑命令、读输出、改文件——不用离开这条任务。" },
        { label: "系统级入口", body: "用快捷方式抵达工作空间，长任务通过通知回报进展。" },
        { label: "长时间任务", body: "要跑几分钟的活儿，在你做别的事情时继续跑。" },
        {
          label: "先问再动的本地操作",
          body: "任何碰到项目之外机器资源的动作，都会先说明自己再等待。",
        },
      ],
      stageAlt:
        "Cognia 桌面外壳的局部特写：命令面板浮在集成终端之上，一条通知正在回报刚完成的后台任务。",
    },

    run: {
      eyebrow: "按你的方式运行",
      title: "选择模型。看清边界。",
      subtitle:
        "不同的活儿配得上不同的运行时。每一种方式都写清：什么会离开你的设备、谁会收到它、哪些动作需要你确认。",
      headings: {
        strategy: "策略",
        leaves: "什么离开设备",
        receives: "谁收到",
        tools: "可调用的工具",
        approval: "需要确认",
      },
      strategies: [
        {
          key: "local",
          name: "本地运行时",
          summary: "模型由你自己的机器、或你自己运维的服务提供。",
          leaves: "当端点在你机器上时，什么都不离开",
          receives: "你配置的那个运行时",
          tools: "你授予这次会话的工具",
          approval: "写到项目之外，以及任何外部调用",
          docsPath: "/docs/chat/provider-system",
        },
        {
          key: "byok",
          name: "自带密钥",
          summary: "你自己的 provider 账号与凭据，存在系统钥匙串里。",
          leaves: "提示词，以及你附加给它的上下文",
          receives: "你选择的那个 provider",
          tools: "你授予这次会话的工具",
          approval: "写到项目之外，以及任何外部调用",
          docsPath: "/docs/chat/provider-system",
        },
        {
          key: "subscription",
          name: "复用已有订阅",
          summary: "复用你本来就在付费的编程订阅，走它自己的登录。",
          leaves: "提示词，以及你附加给它的上下文",
          receives: "该订阅背后的 provider",
          tools: "该订阅的 Agent 支持的工具",
          approval: "写到项目之外，以及任何外部调用",
          docsPath: "/docs/chat/claude-subscription-oauth",
        },
        {
          key: "fallback",
          name: "回退与路由",
          summary: "第一个模型被限流或不可用时，按你设定的规则由第二个接手。",
          leaves: "同一份上下文，发往被选中的那条路由",
          receives: "路由里的下一个 provider",
          tools: "不因切换而改变",
          approval: "不因切换而改变",
          docsPath: "/docs/chat/provider-system",
        },
      ],
      note: "本地、离线、自托管、私有，是四件不同的事。上表每一行都说清了自己是哪一件。",
    },

    connections: {
      eyebrow: "有后果的连接",
      title: "接上工具，别丢了任务。",
      subtitle: "一个连接只有在你能说清它读什么、能做什么、什么时候必须问，才是有用的。",
      headings: {
        reads: "读取",
        canAct: "可执行",
        requiresApproval: "需要审批",
      },
      items: [
        {
          key: "repository",
          name: "代码仓库",
          reads: "代码、issue，以及待审阅的 diff",
          canAct: "提出分支、提交、Pull Request",
          requiresApproval: "任何推送到远端的动作",
        },
        {
          key: "mcp",
          name: "MCP 工具",
          reads: "你传给这次调用的输入",
          canAct: "运行该 server 暴露的工具",
          requiresApproval: "首次使用，以及任何被标记为敏感的调用",
        },
        {
          key: "plugin",
          name: "插件",
          reads: "仅限它 manifest 中声明的能力",
          canAct: "在工作空间中产出或更新产物",
          requiresApproval: "声明范围之外的每一项能力",
        },
        {
          key: "im",
          name: "聊天与通知",
          reads: "发给它的那些消息",
          canAct: "回报进展、请求一个决定",
          requiresApproval: "依据回复去改变任何东西",
        },
      ],
      catalogueNote: "完整的 provider、MCP、插件与连接器目录在文档里，不在这一页。",
      agents: {
        label: "Agent 互通",
        note: "通过 ACP 在工作空间内运行这些 agent，或导入它们已有的会话历史。每个 agent 只在你授予的工具与权限内运行，其步骤进入同一条可审阅的线程。",
        runLabel: "运行",
        importLabel: "导入历史",
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
      eyebrow: "可核对的信任",
      title: "在开放中构建。在使用中受控。",
      subtitle: "四件你可以自己核验的事——不用相信一个营销页面对其中任何一件的说法。",
      cards: [
        {
          key: "source",
          label: "源码",
          body: "整个应用公开，许可证为 AGPL-3.0-or-later——包括那些会接触你的文件、密钥与模型的部分。",
          linkLabel: "阅读源码",
          href: "https://github.com/MaxQian888/cognia-next",
        },
        {
          key: "data",
          label: "数据",
          body: "你的工作存在哪里、一次模型调用携带了什么、由哪个运行时接收——逐项说明，而不是一句总的承诺。",
          linkLabel: "数据与存储",
          route: "/trust",
        },
        {
          key: "permission",
          label: "权限",
          body: "工具声明自己需要的能力。任何伸向项目之外的动作，都会先停下来说明自己再执行。",
          linkLabel: "权限模型",
          route: "/trust",
        },
        {
          key: "record",
          label: "记录",
          body: "步骤、工具调用、审批与结果都挂在产生它们的那条任务上，因此一个结果可以被追溯，也可以被撤回。",
          linkLabel: "记录如何工作",
          route: "/trust",
        },
      ],
      provenanceLabel: "一个动作是如何被交代清楚的",
      provenance: [
        { label: "来源", value: "Agent 读过的仓库与 diff" },
        { label: "动作", value: "提出这次改动的那一步" },
        { label: "权限", value: "你确认过的那个检查点" },
        { label: "结果", value: "产物，以及它背后的测试输出" },
      ],
      statsLabel: "来自仓库",
      starsLabel: "Star",
      contributorsLabel: "贡献者",
      licenseLabel: "许可证",
      releasesLabel: "最新发布",
      noReleasesYet: "尚未发布",
    },

    finalCta: {
      eyebrow: "从这里开始",
      title: "把你的 Agent 收进一个开放的工作空间。",
      support: "桌面优先。开源。为真实工作而建。",
      indexLabel: "今天你能拿到什么",
      rows: [
        { key: "license", label: "许可证" },
        { key: "platforms", label: "支持平台" },
        { key: "release", label: "最新发布" },
        { key: "changes", label: "待发布的变更" },
      ],
      changesSuffix: "条，自上次发布以来",
    },

    sectionIndex: {
      hero: "概览",
      task: "一条任务",
      workbench: "工作台",
      desktop: "桌面",
      run: "运行方式",
      connections: "连接",
      trust: "信任",
      start: "开始",
    },
  },

  product: {
    header: {
      eyebrow: "产品",
      title: "一个工作空间，五个界面，一份工作上下文。",
      subtitle: "下面每一个界面都是应用里真实存在的部分。每一条都链到描述它实际行为的文档。",
    },
    sections: [
      {
        id: "chat",
        title: "对话",
        subtitle:
          "线程是一条任务开始的地方，也是它的记录留下的地方。它承载计划、工具调用、审批与相关文件。",
        entries: [
          {
            key: "chat",
            name: "承载工作的线程",
            body: "一次会话把计划、diff、审批与它产出的产物留在一起，而不是散落在一堆消息里。",
            docsPath: "/docs/chat/chat-and-skills",
          },
          {
            key: "slash",
            name: "斜杠命令与技能",
            body: "具名命令从输入框运行可重复的工作，遵守与其他一切相同的权限规则。",
            docsPath: "/docs/chat/slash-commands",
          },
          {
            key: "providers",
            name: "Provider 体系",
            body: "本地运行时、自己的密钥、已有订阅，以及某一个不可用时的路由规则。",
            docsPath: "/docs/chat/provider-system",
          },
        ],
      },
      {
        id: "agents",
        title: "Agent",
        subtitle: "Agent 有名字、有边界、可审阅。它们带着自己的工具与关卡，而不是继承一切。",
        entries: [
          {
            key: "agents",
            name: "Agent 团队",
            body: "多个 Agent 处理同一条任务，各有分工，由一个 lead 在工作合并前先审阅。",
            docsPath: "/docs/chat/agent-teams",
          },
          {
            key: "execution",
            name: "统一执行",
            body: "内置与外部 Agent 走同一条执行路径，因此行为不会随后端而变。",
            docsPath: "/docs/subsystems/unified-agent-execution",
          },
          {
            key: "external",
            name: "外部 Agent",
            body: "运行你本来就在用的 Agent 后端——由工作空间托管，而不是被它取代。",
            docsPath: "/docs/chat/external-agents",
          },
        ],
      },
      {
        id: "knowledge",
        title: "知识",
        subtitle: "工作空间在任务之间记住的东西、每一条的来源，以及如何删掉它。",
        entries: [
          {
            key: "memory",
            name: "长期记忆",
            body: "带着来源的持久笔记，在任务需要时才浮现，而不是到处注入。",
            docsPath: "/docs/subsystems/long-term-memory",
          },
          {
            key: "capture",
            name: "知识捕获",
            body: "把网页、文档与截图带进来，并把抽取结果留在原件旁边。",
            docsPath: "/docs/subsystems/knowledge-capture",
          },
          {
            key: "storage",
            name: "本地存储与检索",
            body: "工作空间在磁盘上把东西放在哪里，以及检索如何抵达它们。",
            docsPath: "/docs/data/storage",
          },
        ],
      },
      {
        id: "desktop",
        title: "桌面",
        subtitle: "那些只因为工作空间跑在你机器上才存在的部分。",
        entries: [
          {
            key: "terminal",
            name: "集成终端",
            body: "跑那条命令，并把输出留在需要它的那条任务旁边。",
            docsPath: "/docs/subsystems/integrated-terminal",
          },
          {
            key: "ide",
            name: "编辑器与 Pro IDE",
            body: "就地读写项目文件；当改动大过一个 diff 时，还有一个完整编辑器。",
            docsPath: "/docs/subsystems/pro-ide",
          },
          {
            key: "scm",
            name: "源代码管理",
            body: "在工作空间里暂存、审阅与提交，Agent 产出的 diff 就摆在你面前。",
            docsPath: "/docs/subsystems/source-control",
          },
        ],
      },
    ],
  },

  workflows: {
    header: {
      eyebrow: "工作流",
      title: "把已经做过一次的事，变成可重复的那一版。",
      subtitle: "工作流是一张你读得懂的图：节点有声明好的输入，边可以顺着走，每次运行都有状态。",
    },
    sections: [
      {
        title: "搭建",
        subtitle: "可视化编辑器覆盖在一张有类型的图之上，而不是一张需要人去同步的示意图。",
        entries: [
          {
            key: "editor",
            name: "可视化编辑器",
            body: "加节点、连起来、看清每个节点收到什么。这张图就是定义本身，不是定义的图示。",
            docsPath: "/docs/subsystems/visual-workflows",
          },
          {
            key: "nodes",
            name: "来自插件的节点",
            body: "插件按它在别处使用的同一套能力声明，贡献工作流节点。",
            docsPath: "/docs/adr/0017-workflow-plugin-extension-points",
          },
        ],
      },
      {
        title: "运行",
        subtitle: "无论触发者是你、定时器还是 Agent，都是同一个执行器。",
        entries: [
          {
            key: "runner",
            name: "单一执行器",
            body: "对话、定时与 Agent 触发全部走同一条路径，因此工作流不论怎样启动，行为都一致。",
            docsPath: "/docs/subsystems/visual-workflows",
          },
          {
            key: "scheduler",
            name: "定时运行",
            body: "按计划运行并把结果回报给你——包括失败的时候。",
            docsPath: "/docs/subsystems/scheduler",
          },
        ],
      },
    ],
    guarantees: {
      title: "执行器保证什么",
      items: [
        "单一执行路径——工作流由人、定时器还是 Agent 启动，行为完全一致。",
        "环在保存图的时候就被拒绝，而不是等到运行时才发现。",
        "嵌套深度有上界，因此工作流调用工作流不会无限递归。",
        "每个节点的状态都被记录，包括那些从未运行的节点。",
      ],
    },
  },

  plugins: {
    header: {
      eyebrow: "插件",
      title: "扩展工作空间，但不放宽它可以做什么。",
      subtitle:
        "插件在 manifest 里声明它需要的 Cognia 能力。未声明的 Cognia API 会被拒绝，而且你在安装前就能读到这份声明。",
    },
    sections: [
      {
        title: "插件能贡献什么",
        subtitle: "插件可以添加的界面，每一种都受同一套权限规则约束。",
        entries: [
          {
            key: "tools",
            name: "工具",
            body: "Agent 可以调用的新工具，所需能力写得明明白白。",
            docsPath: "/docs/subsystems/plugin-system",
          },
          {
            key: "panels",
            name: "面板与视图",
            body: "在工作空间里拥有自己的界面，就挨着它所属的那条任务。",
            docsPath: "/docs/subsystems/plugin-system",
          },
          {
            key: "nodes",
            name: "工作流节点",
            body: "别人的工作流可以直接用的步骤，贡献方式与工具相同。",
            docsPath: "/docs/adr/0017-workflow-plugin-extension-points",
          },
          {
            key: "commands",
            name: "斜杠命令",
            body: "在输入框里为插件擅长的事提供具名入口。",
            docsPath: "/docs/chat/slash-commands",
          },
        ],
      },
      {
        title: "权限如何生效",
        subtitle: "那份声明就是契约，而且它是被强制执行的，不只是被展示的。",
        entries: [
          {
            key: "manifest",
            name: "声明式能力",
            body: "manifest 列出每一项能力。请求清单之外的能力会直接失败，而不是弹窗询问。",
            docsPath: "/docs/subsystems/plugin-system",
          },
          {
            key: "signing",
            name: "签名与来源",
            body: "一个插件从哪里来，以及这对它被允许做什么意味着什么。",
            docsPath: "/docs/plugins/plugin-signing",
          },
          {
            key: "sandbox",
            name: "宿主页执行",
            body: "插件 bundle 当前通过 indirect eval 在宿主页中执行。能力检查会约束 Cognia API，但 ambient browser globals 仍可访问；这不是代码隔离 sandbox。",
            docsPath: "/docs/subsystems/sandbox",
          },
        ],
      },
    ],
    authoring: {
      title: "写一个",
      body: "插件 CLI 负责脚手架、构建与打包，并且可以把已有的 MCP server、skill 或 CLI 直接转成插件，不用写插件代码。",
      steps: [
        "生成脚手架，并声明它需要的能力。",
        "实现它贡献的界面——工具、面板、工作流节点、命令。",
        "打包并本地安装，用实际调用去对照那份声明。",
      ],
    },
  },

  trust: {
    header: {
      eyebrow: "信任",
      title: "这个站点上的每一条主张，以及去哪里核验。",
      subtitle:
        "开源是一个可以核验的属性，不是一枚徽章。这一页列出 Cognia 对你的工作做了什么，并指向证明每句话的那件东西。",
    },
    sections: [
      {
        title: "数据边界",
        subtitle: "你的工作住在哪里，以及一次模型调用实际携带了什么。",
        entries: [
          {
            key: "storage",
            name: "本地存储",
            body: "会话、产物、记忆与设置存在你的机器上。文档描述了 schema 与位置。",
            docsPath: "/docs/data/storage",
          },
          {
            key: "backup",
            name: "备份与导出",
            body: "你的数据可以按文档化的格式导出与还原——这才是「它到底是不是你的」的检验标准。",
            docsPath: "/docs/data/backup-and-data",
          },
          {
            key: "model",
            name: "什么会抵达模型",
            body: "一次调用携带提示词与你附加的上下文，发往你选择的运行时。provider 文档说明了那是哪一个。",
            docsPath: "/docs/chat/provider-system",
          },
        ],
      },
      {
        title: "权限与记录",
        subtitle: "什么会在动手之前停下，以及事后留下了什么。",
        entries: [
          {
            key: "approval",
            name: "审批检查点",
            body: "离开项目的动作——推送、调用外部工具、写到磁盘别处——会先说明自己再等待。",
            docsPath: "/docs/subsystems/unified-agent-execution",
          },
          {
            key: "capabilities",
            name: "能力声明",
            body: "插件与工具只能够到 manifest 中声明的东西，而能力清单本身是公开的。",
            docsPath: "/docs/subsystems/plugin-system",
          },
          {
            key: "sandbox",
            name: "执行模型",
            body: "插件 bundle 通过 indirect eval 在宿主页中执行。声明的能力会限制 Cognia API，但 ambient browser globals 仍可访问。",
            docsPath: "/docs/subsystems/sandbox",
          },
        ],
      },
    ],
    evidence: {
      title: "主张与来源",
      subtitle: "这张表里没有一行是手工维护的。每一行都指向该主张被读取的那件东西。",
      headings: { claim: "主张", source: "来源" },
      liveLabel: "实时数据",
      rows: [
        {
          claim: "应用以 AGPL-3.0-or-later 授权",
          source: "仓库中的 LICENSE",
          href: "https://github.com/MaxQian888/cognia-next/blob/master/LICENSE",
        },
        {
          claim: "源码公开且完整",
          source: "仓库本身",
          href: "https://github.com/MaxQian888/cognia-next",
        },
        {
          claim: "桌面产物由带签名的流程产出",
          source: "仓库中的发布 workflow",
          href: "https://github.com/MaxQian888/cognia-next/blob/master/.github/workflows/release.yml",
        },
        {
          claim: "已发布的版本与支持的平台",
          source: "GitHub Releases，构建期读取",
          href: "https://github.com/MaxQian888/cognia-next/releases",
        },
        {
          claim: "每个子系统的实际行为",
          source: "架构决策记录",
          docsPath: "/docs/adr/0092-official-website-workspace",
        },
      ],
    },
  },

  download: {
    header: {
      eyebrow: "下载",
      title: "在你自己的机器上运行它。",
      subtitle: "Cognia 是一个桌面应用。当有版本发布时，下面的安装包来自公开源码的带签名构建。",
    },
    buildFromSource: {
      title: "从源码构建",
      body: "桌面构建可以从仓库复现。发布流程走的就是这条路径。",
      steps: [
        { label: "克隆仓库", command: "git clone https://github.com/MaxQian888/cognia-next" },
        { label: "安装依赖", command: "pnpm install" },
        { label: "构建桌面应用", command: "pnpm tauri build" },
      ],
    },
    requirements: {
      title: "你需要什么",
      items: [
        "Node.js 与 pnpm，用于安装依赖并构建前端。",
        "一套 Rust 工具链，因为桌面外壳是编译出来的，不是打包出来的。",
        "一个可以对话的模型：本地运行时、provider 密钥，或你已有的订阅。",
      ],
    },
    platformsTitle: "平台",
    platformHint: { label: "已识别", unknown: "未能识别平台" },
  },

  useCases: {
    development: {
      header: {
        eyebrow: "用例 · 开发",
        title: "审阅发布、修好检查、写出说明。",
        subtitle: "整个站点跟随的那条任务，跑在一个真实代码库上——Cognia 自己所在的那一个。",
      },
      provenance:
        "这条剧本是 dogfooding：它描述的是如何用 Cognia 开发 Cognia 自己的仓库。它不是客户案例，也不含任何效能数字。",
      scriptTitle: "剧本，一步一步",
      stageAlt:
        "Cognia 工作台正在跑这条剧本：左边是承载任务的线程，右边的工作空间里是它产出的东西。",
      stageCaption: "同一个工作台，跑的就是本页这条剧本。",
      steps: [
        {
          rail: "上下文",
          title: "把它指向这次改动，而不是整个代码库",
          body: "打开项目，把待审阅的 diff 和仓库自带的说明交给 Agent。它在提出任何方案之前，先说清自己读了什么。",
          detail: "项目 · diff · 仓库说明",
        },
        {
          rail: "计划",
          title: "在任何文件移动之前先读计划",
          body: "计划写明步骤、每步需要的工具、以及它将写入的路径。你可以改，也可以打回；此时还什么都没被碰过。",
          detail: "计划已批准",
        },
        {
          rail: "执行",
          title: "以 diff 的形式接收修复",
          body: "改动就地出现、归属到产生它的那一步，在离开工作空间之前都可以在工作区里撤销。",
          detail: "工作区中已改动的文件",
        },
        {
          rail: "审批",
          title: "在边界处停住",
          body: "推送分支是一个检查点。动作被说清，然后等一个人。",
          detail: "推送到 origin · 等待确认",
        },
        {
          rail: "测试",
          title: "重跑那个失败的检查",
          body: "集成终端跑发布时失败的同一个检查，输出留在造成它的那处改动旁边。",
          detail: "项目自己的测试命令",
        },
        {
          rail: "产物",
          title: "把说明留成一份文件",
          body: "发布说明作为产物落在工作空间里，与任务一起留痕，随时可编辑或导出。",
          detail: "launch-notes.md",
        },
      ],
      capabilities: {
        title: "这条剧本用到了什么",
        subtitle: "上面剧本里的每一项能力，以及它们的文档在哪里。",
        entries: [
          {
            key: "scm",
            name: "源代码管理",
            body: "读取 diff、暂存修复，并在推送之前停住。",
            docsPath: "/docs/subsystems/source-control",
          },
          {
            key: "terminal",
            name: "集成终端",
            body: "运行失败的检查，并把输出留在改动旁边。",
            docsPath: "/docs/subsystems/integrated-terminal",
          },
          {
            key: "agents",
            name: "Agent 执行",
            body: "计划、步骤，以及它们之间的审批检查点。",
            docsPath: "/docs/subsystems/unified-agent-execution",
          },
        ],
      },
    },

    research: {
      header: {
        eyebrow: "用例 · 研究",
        title: "读进来、抽出来，下个月还找得到。",
        subtitle: "读只是研究的一半。这条剧本讲的是标签页关掉之后还剩下什么。",
      },
      provenance:
        "这条剧本使用的是今天已经在跑的能力——阅读、抽取、捕获与记忆。它描述的是工具做了什么，不是某个研究者用它们取得了什么成果。",
      scriptTitle: "剧本，一步一步",
      stageAlt:
        "Cognia 工作台正在跑这条剧本：左边是承载任务的线程，右边的工作空间里是它产出的东西。",
      stageCaption: "同一个工作台，跑的就是本页这条剧本。",
      steps: [
        {
          rail: "收集",
          title: "把材料带进来",
          body: "网页、文档与截图作为捕获项进入工作空间，原件与从中抽取的内容留在一起。",
          detail: "捕获项 · 保留原件",
        },
        {
          rail: "阅读",
          title: "把一个页面变成可以处理的文本",
          body: "阅读器抽出可读正文，因此材料可以被引用与核对，而不是被摘要掉。",
          detail: "已抽取正文",
        },
        {
          rail: "抽取",
          title: "从不是文本的东西里取出文本",
          body: "截图与扫描件走 OCR，识别出的文本仍然挂在它来自的那张图上。",
          detail: "OCR 结果 · 关联原件",
        },
        {
          rail: "留存",
          title: "决定什么值得被记住",
          body: "结论成为带来源记录的持久记忆，在后续任务需要时才浮现，而不是注入到所有地方。",
          detail: "记忆条目 · 已记录来源",
        },
        {
          rail: "复用",
          title: "让这次阅读可以重来",
          body: "当同样的收集需要再做一次时，这些步骤变成一条工作流，可以定时运行并回报它找到了什么。",
          detail: "工作流 · 定时运行",
        },
      ],
      capabilities: {
        title: "这条剧本用到了什么",
        subtitle: "上面剧本里的每一项能力，以及它们的文档在哪里。",
        entries: [
          {
            key: "capture",
            name: "知识捕获",
            body: "把网页、文档与截图带进工作空间，且来源不丢。",
            docsPath: "/docs/subsystems/knowledge-capture",
          },
          {
            key: "ocr",
            name: "OCR",
            body: "识别图片与扫描件中的文本，并保持与原件的关联。",
            docsPath: "/docs/subsystems/ocr",
          },
          {
            key: "memory",
            name: "长期记忆",
            body: "带来源的持久笔记，在相关时被检索出来。",
            docsPath: "/docs/subsystems/long-term-memory",
          },
          {
            key: "workflows",
            name: "工作流",
            body: "把这轮收集变成可以自己再跑一次的东西。",
            docsPath: "/docs/subsystems/visual-workflows",
          },
        ],
      },
    },
  },

  changelog: {
    header: {
      eyebrow: "变更日志",
      title: "改了什么，写给它影响的人看。",
      subtitle:
        "每一条都在造成它的那次改动旁边被记录下来，所以这一页由仓库生成，而不是事后回忆出来。",
    },
    unreleasedTitle: "未发布",
    unreleasedNote:
      "这些改动已经合入，等待第一个打了 tag 的发布。每一条都是在改动发生的当时写下的。",
    releasedTitle: "已发布",
    emptyState: "暂无条目。",
    bumpLabels: { major: "破坏性", minor: "功能", patch: "修复" },
    entryCount: "{count} 条",
    distributionLabel: "按版本级别",
    monthIndexLabel: "跳到某个月份",
  },
}
