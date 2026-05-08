#!/usr/bin/env node
/**
 * One-shot helper that injects the Wave 2 mobile-shell i18n namespace into
 * both en.json and zh-CN.json without touching surrounding keys. Run once
 * during Wave 2.4 to seed the strings; subsequent additions go through the
 * usual edit-message-file flow.
 */

import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")

const ZH_PATH = resolve(root, "i18n/messages/zh-CN.json")
const EN_PATH = resolve(root, "i18n/messages/en.json")

const ZH_MOBILE = {
  tabs: {
    chat: "聊天",
    workflows: "工作流",
    discover: "发现",
    me: "我",
  },
  tabBar: {
    unread: "{count} 未读",
  },
  pair: {
    title: "连接桌面",
    intro:
      "扫一下桌面端的二维码即可完成配对。也可以手动粘贴桌面 Settings → Companion 卡片里的 5 分钟令牌。",
    scanCta: "扫码配对",
    manualDivider: "或手动粘贴",
    baseUrlLabel: "服务器地址",
    tokenLabel: "配对令牌",
    fingerprintPinned: "✓ 桌面身份已锁定",
    submit: "完成配对",
    submitInProgress: "正在配对…",
    transportLabel: "传输层",
    signOutTitle: "退出登录",
    signOutReason: "确认退出当前配对",
    signOutDescription: "退出后需重新扫码配对才能再次连接。",
    biometricFailed: "生物识别失败（{reason}），未退出登录。",
  },
  discover: {
    title: "发现",
    tabs: {
      characters: "角色",
      teams: "团队",
      skills: "技能",
      twinDrafts: "孪生草稿",
    },
    builtInBadge: "内置",
    memberCount: "{count} 个智能体",
    emptyCharacters: "还没有角色 — 在桌面端创建一个吧。",
    emptyTeams: "还没有团队。",
    emptySkills: "还没有技能。",
    emptyTwinDrafts: "暂无待审孪生草稿。",
  },
  me: {
    title: "我",
    pairing: "配对状态",
    pairingPaired: "已与桌面配对（{deviceId}）",
    pairingUnpaired: "尚未与桌面配对",
    actionPair: "去配对",
    sectionAccount: "账户",
    sectionData: "数据与备份",
    sectionAppearance: "外观与语言",
    sectionAdvanced: "高级",
    settingsLink: "应用设置",
    backupLink: "备份与同步",
    appSecurity: "应用安全",
    biometricToggle: "启用生物识别解锁",
    biometricUnavailable: "本设备未注册生物识别。",
    versionLabel: "版本",
  },
  companion: {
    tunnel: {
      title: "Cloudflared 隧道",
      description: "出门在外时让手机能连上桌面。需先安装 cloudflared CLI。",
      started: "隧道已启动。",
      stopped: "隧道已停止。",
      notInstalled: "找不到 cloudflared，先 brew/winget/apt 安装。",
      off: "关闭中。开关打开后会以子进程方式拉起 cloudflared。",
      onlyDesktop: "隧道仅在桌面运行时可用。",
      enableLabel: "Enable cloudflared tunnel",
    },
    mdns: {
      title: "LAN 自动发现 (mDNS)",
      description: "在局域网广播 _cognia._tcp，手机不用扫码也能找到桌面。",
      started: "LAN 广播已启动。",
      stopped: "LAN 广播已停止。",
      onlyDesktop: "LAN 广播仅在桌面运行时可用。",
      enableLabel: "Enable mDNS broadcast",
    },
    revoke: {
      reason: "确认解除 {label} 的配对",
      title: "解除配对",
      description: "解除后此设备将立即失去访问权限。",
      blocked: "解除配对未完成（{reason}）。",
      successToast: "已解除该设备的配对。",
    },
  },
  twinDraft: {
    kindCharacter: "角色",
    kindSkill: "技能",
    statusPending: "待审",
    statusAccepted: "已接受",
    statusRejected: "已拒绝",
    statusEdited: "已编辑",
    untitled: "未命名草稿",
    noSummary: "无摘要",
    qualityScore: "评分 {percent}%",
  },
}

const EN_MOBILE = {
  tabs: {
    chat: "Chat",
    workflows: "Workflows",
    discover: "Discover",
    me: "Me",
  },
  tabBar: {
    unread: "{count} unread",
  },
  pair: {
    title: "Connect to desktop",
    intro:
      "Scan the QR shown in desktop Settings → Companion. You can also paste the 5-minute pair token manually.",
    scanCta: "Scan QR",
    manualDivider: "or paste manually",
    baseUrlLabel: "Server URL",
    tokenLabel: "Pair token",
    fingerprintPinned: "✓ Desktop identity pinned",
    submit: "Complete pairing",
    submitInProgress: "Pairing…",
    transportLabel: "Transport",
    signOutTitle: "Sign out",
    signOutReason: "Confirm sign out",
    signOutDescription: "You'll need to scan the QR again to reconnect.",
    biometricFailed: "Biometric check failed ({reason}); did not sign out.",
  },
  discover: {
    title: "Discover",
    tabs: {
      characters: "Characters",
      teams: "Teams",
      skills: "Skills",
      twinDrafts: "Twin drafts",
    },
    builtInBadge: "Built-in",
    memberCount: "{count} agents",
    emptyCharacters: "No characters yet — create one on the desktop.",
    emptyTeams: "No teams yet.",
    emptySkills: "No skills yet.",
    emptyTwinDrafts: "No pending twin drafts.",
  },
  me: {
    title: "Me",
    pairing: "Pairing status",
    pairingPaired: "Paired with desktop ({deviceId})",
    pairingUnpaired: "Not paired with desktop yet",
    actionPair: "Pair now",
    sectionAccount: "Account",
    sectionData: "Data & backup",
    sectionAppearance: "Appearance & language",
    sectionAdvanced: "Advanced",
    settingsLink: "App settings",
    backupLink: "Backup & sync",
    appSecurity: "App security",
    biometricToggle: "Require biometric to unlock",
    biometricUnavailable: "This device has no biometric enrolled.",
    versionLabel: "Version",
  },
  companion: {
    tunnel: {
      title: "Cloudflared tunnel",
      description:
        "Reach this desktop from anywhere. Requires the cloudflared CLI to be installed.",
      started: "Tunnel started.",
      stopped: "Tunnel stopped.",
      notInstalled: "cloudflared not found — install via brew/winget/apt first.",
      off: "Off. Turning the switch on launches cloudflared as a subprocess.",
      onlyDesktop: "Tunnel control is desktop-only.",
      enableLabel: "Enable cloudflared tunnel",
    },
    mdns: {
      title: "LAN auto-discovery (mDNS)",
      description: "Broadcast _cognia._tcp on the LAN so phones find this desktop without QR scan.",
      started: "LAN broadcast started.",
      stopped: "LAN broadcast stopped.",
      onlyDesktop: "LAN broadcast is desktop-only.",
      enableLabel: "Enable mDNS broadcast",
    },
    revoke: {
      reason: "Confirm revoking pairing for {label}",
      title: "Revoke pairing",
      description: "The device loses access immediately.",
      blocked: "Revoke not completed ({reason}).",
      successToast: "Device revoked.",
    },
  },
  twinDraft: {
    kindCharacter: "Character",
    kindSkill: "Skill",
    statusPending: "Pending",
    statusAccepted: "Accepted",
    statusRejected: "Rejected",
    statusEdited: "Edited",
    untitled: "Untitled draft",
    noSummary: "No summary",
    qualityScore: "Score {percent}%",
  },
}

async function inject(path, mobileNamespace) {
  const text = await readFile(path, "utf8")
  const json = JSON.parse(text)
  // Deep merge so re-running the script is idempotent.
  json.mobile = { ...(json.mobile ?? {}), ...mobileNamespace }
  await writeFile(path, JSON.stringify(json, null, 2) + "\n", "utf8")
}

await inject(ZH_PATH, ZH_MOBILE)
await inject(EN_PATH, EN_MOBILE)
console.log("Injected `mobile` namespace into en.json + zh-CN.json")
