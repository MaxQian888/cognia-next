/**
 * Apply mobile i18n patch — adds the missing translation namespaces that
 * mobile components reference via useTranslations(). Mobile pages were
 * rendering literal key paths (e.g. "mobile.home.search") because these
 * namespaces never made it into en.json / zh-CN.json.
 *
 * Idempotent: merges only keys that don't already exist; safe to re-run.
 */
import fs from "node:fs"

const enPath = "i18n/messages/en.json"
const zhPath = "i18n/messages/zh-CN.json"

const en = JSON.parse(fs.readFileSync(enPath, "utf8"))
const zh = JSON.parse(fs.readFileSync(zhPath, "utf8"))

const enPatch = {
  desktop: {
    shell: {
      emptyTitle: "Cognia",
    },
  },
  mobile: {
    shell: {
      openNav: "Open navigation",
      navSheetTitle: "Navigation",
      openMembers: "Open team members",
      sessionMenu: "Session menu",
      newChat: "New chat",
      settings: "Settings",
      deleteSession: "Delete this session",
      memberSheetTitle: "Team members",
      directSessionTitle: "Chat with {name}",
      tabBarAria: "Main navigation",
      clearSearch: "Clear search",
    },
    home: {
      search: "Search chats…",
      searchAria: "Search chats",
      pinned: "Pinned",
      recent: "Recent",
      emptyChats: "No chats yet. Tap + to start one.",
      emptyFiltered: "No chats match “{query}”.",
      swipePin: "Pin",
      swipeUnpin: "Unpin",
      swipeDelete: "Delete",
      presenceStreaming: "Streaming",
    },
    discover: {
      search: "Search discover…",
      searchAria: "Search discover",
      featured: "Featured",
    },
    pair: {
      discover: {
        title: "Find your desktop",
        subtitle: "Pick a server below, or skip to enter details manually.",
        scanning: "Scanning the local network…",
        rescanCta: "Rescan",
        skipToManual: "Enter manually",
        foundCount: "{count, plural, =0 {No servers found} =1 {1 server} other {# servers}}",
        emptyTitle: "No servers detected",
        emptyDescription:
          "Make sure the desktop is on the same network with the companion server enabled.",
        backToDiscover: "Back to discover",
        baseUrlLocked: "URL locked from discovery",
        latencyMs: "{ms} ms",
        tlsPinned: "Identity verified",
        tlsUnverified: "Unverified",
        viaMdns: "mDNS",
        viaProbe: "LAN probe",
        viaHistory: "History",
      },
      permissions: {
        localNetwork: {
          title: "Local network access required",
          description:
            "Grant local-network access so the phone can find the desktop on your Wi-Fi.",
        },
      },
      step: {
        ariaLabel: "Pairing progress",
        discover: "Discover",
        pair: "Pair",
        paired: "Connected",
      },
      scanError: {
        notPairCode: "That QR code isn't a Cognia pair code.",
        permissionDenied:
          "Camera permission denied. Enable it in system settings to scan QR codes.",
        unsupported: "This device can't scan QR codes. Paste the pair token manually below.",
        failed: "Scan failed: {message}",
      },
    },
    me: {
      profile: {
        fallbackName: "Signed-out",
        fallbackPlan: "Local account",
        manageAccount: "Manage account",
      },
      quickToggles: {
        themeAria: "Switch theme",
        languageAria: "Switch language",
        themeLight: "Light",
        themeDark: "Dark",
        themeAuto: "Auto",
      },
      todayStats: {
        sessions: "Sessions",
        drafts: "Drafts",
        backup: "Last backup",
        backupNever: "Never",
      },
    },
    settingsPanel: {
      theme: "Theme",
      themeLight: "Light",
      themeDark: "Dark",
      themeSystem: "System",
      fontScale: "Font scale",
      fontScaleSm: "S",
      fontScaleMd: "M",
      fontScaleLg: "L",
      language: "Language",
      defaultModel: "Default model",
      queueLabel: "Queued — desktop will apply this when online.",
    },
    characterEdit: {
      createTitle: "New character",
      editTitle: "Edit character",
      description: "Tune the system prompt, model, and avatar.",
      nameLabel: "Name",
      descriptionLabel: "Description",
      systemPromptLabel: "System prompt",
      defaultModelLabel: "Default model",
      avatarEmojiLabel: "Avatar emoji",
      avatarColorLabel: "Avatar color",
      save: "Save",
      saving: "Saving…",
      savedCreate: "Character created.",
      savedUpdate: "Character updated.",
      saveFailed: "Save failed: {message}",
      create: "Create",
      delete: "Delete",
      deleted: "Character deleted.",
      deleteFailed: "Delete failed: {message}",
      cannotDeleteBuiltIn: "Built-in characters can't be deleted.",
      queueLabelCreate: "Queued — desktop will create when online.",
      queueLabelUpdate: "Queued — desktop will save when online.",
      queueLabelDelete: "Queued — desktop will delete when online.",
    },
    connectorPolicy: {
      title: "Conversation settings",
      description: "Choose how this conversation handles incoming messages.",
      defaultMode: "Default mode",
      defaultModeHelp: "Auto replies via AI. Draft requires your approval. Manual silences AI.",
      modeAuto: "Auto",
      modeDraft: "Draft",
      modeManual: "Manual",
      quietHours: "Quiet hours",
      quietHoursHelp: "Outbound replies pause during this window.",
      from: "From",
      to: "To",
      muted: "Mute this conversation",
      mutedHelp: "Inbound messages still arrive; outbound replies are blocked.",
      save: "Save",
      saving: "Saving…",
      saved: "Settings saved.",
      saveFailed: "Save failed: {message}",
      queueLabel: "Queued — desktop will apply when online.",
    },
    plugins: {
      empty: "No plugins installed.",
      enabled: "Enabled",
      disabled: "Disabled",
      toggleAria: "Toggle plugin",
      toggleFailed: "Toggle failed: {message}",
      queueLabel: "Queued — desktop will apply when online.",
    },
    twinProfile: {
      title: "Twin profile",
      loading: "Loading twin profile…",
      loadFailed: "Couldn't load twin profile.",
      empty: "No twin profile yet. Add a source on the desktop to start.",
      entities: "{count, plural, =0 {No entities} =1 {1 entity} other {# entities}}",
      samples: "{count, plural, =0 {No samples} =1 {1 sample} other {# samples}}",
      style: "Style",
      updatedAt: "Updated {when}",
      noUpdates: "Not yet generated",
    },
    workflow: {
      all: "All",
      pinned: "Pinned",
      pinned_added: "Pinned.",
      pinned_removed: "Unpinned.",
    },
    backup: {
      exportBiometricTitle: "Confirm export",
      exportBiometricReason: "Authenticate to export an encrypted backup.",
      biometricBlocked: "Biometric check failed. Export cancelled.",
      passphraseRequiredHint: "Required so the encrypted archive can be opened later.",
    },
  },
}

const zhPatch = {
  desktop: {
    shell: {
      emptyTitle: "Cognia",
    },
  },
  mobile: {
    shell: {
      openNav: "打开导航",
      navSheetTitle: "导航",
      openMembers: "打开成员列表",
      sessionMenu: "会话菜单",
      newChat: "新建聊天",
      settings: "设置",
      deleteSession: "删除此会话",
      memberSheetTitle: "团队成员",
      directSessionTitle: "与 {name} 的聊天",
      tabBarAria: "主导航",
      clearSearch: "清空搜索",
    },
    home: {
      search: "搜索聊天…",
      searchAria: "搜索聊天",
      pinned: "置顶",
      recent: "最近",
      emptyChats: "还没有聊天，点击 + 新建一个。",
      emptyFiltered: "没有与「{query}」匹配的聊天。",
      swipePin: "置顶",
      swipeUnpin: "取消置顶",
      swipeDelete: "删除",
      presenceStreaming: "回复中",
    },
    discover: {
      search: "搜索…",
      searchAria: "搜索发现内容",
      featured: "精选",
    },
    pair: {
      discover: {
        title: "查找你的桌面",
        subtitle: "选择下方的服务器，或跳过手动输入。",
        scanning: "正在扫描局域网…",
        rescanCta: "重新扫描",
        skipToManual: "手动输入",
        foundCount: "{count, plural, =0 {未发现服务器} other {发现 # 台}}",
        emptyTitle: "未发现服务器",
        emptyDescription: "请确认桌面与手机连在同一网络，且桌面端已开启 Companion 服务。",
        backToDiscover: "返回扫描列表",
        baseUrlLocked: "地址已从扫描结果锁定",
        latencyMs: "{ms} 毫秒",
        tlsPinned: "身份已验证",
        tlsUnverified: "未验证",
        viaMdns: "mDNS",
        viaProbe: "局域网探测",
        viaHistory: "历史",
      },
      permissions: {
        localNetwork: {
          title: "需要本地网络权限",
          description: "请授予本地网络访问权限，本机才能在 Wi-Fi 上发现桌面端。",
        },
      },
      step: {
        ariaLabel: "配对进度",
        discover: "发现",
        pair: "配对",
        paired: "已连接",
      },
      scanError: {
        notPairCode: "这个二维码不是 Cognia 配对码。",
        permissionDenied: "未授予相机权限。请在系统设置里开启后再扫码。",
        unsupported: "本设备不支持扫码，请在下方手动粘贴配对令牌。",
        failed: "扫码失败：{message}",
      },
    },
    me: {
      profile: {
        fallbackName: "未登录",
        fallbackPlan: "本机账号",
        manageAccount: "管理账号",
      },
      quickToggles: {
        themeAria: "切换主题",
        languageAria: "切换语言",
        themeLight: "浅色",
        themeDark: "深色",
        themeAuto: "自动",
      },
      todayStats: {
        sessions: "会话",
        drafts: "草稿",
        backup: "上次备份",
        backupNever: "从未",
      },
    },
    settingsPanel: {
      theme: "主题",
      themeLight: "浅色",
      themeDark: "深色",
      themeSystem: "跟随系统",
      fontScale: "字号",
      fontScaleSm: "小",
      fontScaleMd: "中",
      fontScaleLg: "大",
      language: "语言",
      defaultModel: "默认模型",
      queueLabel: "已排队——桌面上线后会自动同步。",
    },
    characterEdit: {
      createTitle: "新建角色",
      editTitle: "编辑角色",
      description: "调整系统提示词、模型和头像。",
      nameLabel: "名称",
      descriptionLabel: "描述",
      systemPromptLabel: "系统提示词",
      defaultModelLabel: "默认模型",
      avatarEmojiLabel: "头像表情",
      avatarColorLabel: "头像颜色",
      save: "保存",
      saving: "保存中…",
      savedCreate: "角色已创建。",
      savedUpdate: "角色已更新。",
      saveFailed: "保存失败：{message}",
      create: "创建",
      delete: "删除",
      deleted: "角色已删除。",
      deleteFailed: "删除失败：{message}",
      cannotDeleteBuiltIn: "内置角色不可删除。",
      queueLabelCreate: "已排队——桌面上线后会创建。",
      queueLabelUpdate: "已排队——桌面上线后会保存。",
      queueLabelDelete: "已排队——桌面上线后会删除。",
    },
    connectorPolicy: {
      title: "会话设置",
      description: "选择此会话如何处理收到的消息。",
      defaultMode: "默认模式",
      defaultModeHelp: "Auto：AI 自动回复；Draft：起草草稿等你确认；Manual：完全手动。",
      modeAuto: "自动",
      modeDraft: "草稿",
      modeManual: "手动",
      quietHours: "免打扰时段",
      quietHoursHelp: "此时段内不发出自动回复。",
      from: "起始",
      to: "结束",
      muted: "静音此会话",
      mutedHelp: "仍能收到消息，但不会自动回复。",
      save: "保存",
      saving: "保存中…",
      saved: "已保存。",
      saveFailed: "保存失败：{message}",
      queueLabel: "已排队——桌面上线后会同步。",
    },
    plugins: {
      empty: "尚未安装任何插件。",
      enabled: "已启用",
      disabled: "已禁用",
      toggleAria: "切换插件状态",
      toggleFailed: "切换失败：{message}",
      queueLabel: "已排队——桌面上线后会同步。",
    },
    twinProfile: {
      title: "数字分身画像",
      loading: "加载分身画像…",
      loadFailed: "无法加载分身画像。",
      empty: "尚未生成分身画像。请在桌面端添加资料源后再试。",
      entities: "{count, plural, =0 {无实体} other {# 个实体}}",
      samples: "{count, plural, =0 {无样本} other {# 个样本}}",
      style: "风格",
      updatedAt: "更新于 {when}",
      noUpdates: "尚未生成",
    },
    workflow: {
      all: "全部",
      pinned: "置顶",
      pinned_added: "已置顶。",
      pinned_removed: "已取消置顶。",
    },
    backup: {
      exportBiometricTitle: "确认导出",
      exportBiometricReason: "通过生物识别验证后导出加密备份。",
      biometricBlocked: "生物识别失败，已取消导出。",
      passphraseRequiredHint: "需要密码短语才能在以后解开加密备份。",
    },
  },
}

function deepMerge(target, patch) {
  let added = 0
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== "object" || Array.isArray(target[k])) {
        target[k] = {}
      }
      added += deepMerge(target[k], v)
    } else if (!(k in target)) {
      target[k] = v
      added++
    }
  }
  return added
}

const enAdded = deepMerge(en, enPatch)
const zhAdded = deepMerge(zh, zhPatch)

fs.writeFileSync(enPath, JSON.stringify(en, null, 2) + "\n", "utf8")
fs.writeFileSync(zhPath, JSON.stringify(zh, null, 2) + "\n", "utf8")

console.log(`en.json: added ${enAdded} new keys`)
console.log(`zh-CN.json: added ${zhAdded} new keys`)
