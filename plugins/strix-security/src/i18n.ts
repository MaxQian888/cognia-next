// Declarative i18n bundle. Overlaid into the host next-intl tree under
// `plugin.strix-security.*` on enable (via `manifest.i18n.locales`), and read
// directly by `usePluginT()`. Keys are authored fully-prefixed here; the hook
// passes them unprefixed and adds the `plugin.strix-security.` prefix.

export const I18N_MESSAGES = {
  en: {
    "plugin.strix-security.panel.title": "Security",
    "plugin.strix-security.panel.tab.scan": "Scan",
    "plugin.strix-security.panel.tab.history": "History",

    "plugin.strix-security.preflight.checking": "Checking environment…",
    "plugin.strix-security.preflight.ready": "Docker and strix are ready.",
    "plugin.strix-security.preflight.dockerMissing":
      "Docker daemon is not reachable. Start Docker, then re-check.",
    "plugin.strix-security.preflight.strixMissing": "The strix CLI was not found on your PATH.",
    "plugin.strix-security.preflight.install":
      "Install Strix with `pipx install strix-agent`, start Docker, then re-check.",
    "plugin.strix-security.preflight.retry": "Re-check",
    "plugin.strix-security.preflight.strixVersion": "strix {version}",

    "plugin.strix-security.form.targetLabel": "Target",
    "plugin.strix-security.form.targetPlaceholder": "https://example.com or ./local-app",
    "plugin.strix-security.form.advanced": "Advanced",
    "plugin.strix-security.form.modelLabel": "Model override (optional)",
    "plugin.strix-security.form.modelPlaceholder":
      "e.g. openai/gpt-5 — blank uses your shell STRIX_LLM",
    "plugin.strix-security.form.apiKeyLabel": "API key override (optional, not saved)",
    "plugin.strix-security.form.apiKeyPlaceholder": "LLM_API_KEY for this scan only",
    "plugin.strix-security.form.authLabel":
      "I am authorized to run a penetration test against this target.",
    "plugin.strix-security.form.authWarning":
      "Strix actively attacks the target. Only scan systems you own or are explicitly authorized to test — unauthorized testing may be illegal.",
    "plugin.strix-security.form.start": "Start scan",
    "plugin.strix-security.form.cancel": "Cancel",
    "plugin.strix-security.form.targetRequired": "Enter a target to scan.",

    "plugin.strix-security.console.title": "Output",
    "plugin.strix-security.console.empty": "Scan output will stream here.",
    "plugin.strix-security.console.truncated":
      "Earlier output was dropped — showing the most recent output only.",

    "plugin.strix-security.run.scanning": "Scanning {target} — findings appear when it finishes.",
    "plugin.strix-security.run.failed": "Scan failed",
    "plugin.strix-security.run.cancelled": "Scan cancelled",

    "plugin.strix-security.findings.none": "No vulnerabilities found.",
    "plugin.strix-security.findings.count": "{count} findings",
    "plugin.strix-security.findings.filter.all": "All {count}",
    "plugin.strix-security.findings.filter.open": "Open {count}",
    "plugin.strix-security.findings.filterEmpty": "No findings in this view.",

    "plugin.strix-security.severity.critical": "{count} critical",
    "plugin.strix-security.severity.high": "{count} high",
    "plugin.strix-security.severity.medium": "{count} medium",
    "plugin.strix-security.severity.low": "{count} low",
    "plugin.strix-security.severity.info": "{count} info",

    "plugin.strix-security.finding.impact": "Impact",
    "plugin.strix-security.finding.technical": "Technical analysis",
    "plugin.strix-security.finding.poc": "Proof of concept",
    "plugin.strix-security.finding.remediation": "Remediation",
    "plugin.strix-security.finding.locations": "Code locations",
    "plugin.strix-security.finding.locationUnknown": "Unknown location",
    "plugin.strix-security.finding.cvss": "CVSS {score}",

    "plugin.strix-security.triage.label": "Verdict",
    "plugin.strix-security.triage.state.open": "Open",
    "plugin.strix-security.triage.state.accepted": "Risk accepted",
    "plugin.strix-security.triage.state.false-positive": "False positive",
    "plugin.strix-security.triage.state.fixed": "Fixed",
    "plugin.strix-security.triage.suppressed": "Muted",
    "plugin.strix-security.triage.muteRule": "Mute all {rule}",
    "plugin.strix-security.triage.unmuteRule": "Unmute {rule}",
    "plugin.strix-security.triage.mutedCount": "{count} muted",

    "plugin.strix-security.export.sarif": "Export SARIF",

    "plugin.strix-security.history.title": "Scan history",
    "plugin.strix-security.history.empty": "No scans yet.",
    "plugin.strix-security.history.findingsCount": "{count} findings",
    "plugin.strix-security.history.delete": "Delete",
    "plugin.strix-security.history.deleteRunningDisabled": "Stop the scan before deleting it",
    "plugin.strix-security.history.clearAll": "Clear all",
    "plugin.strix-security.history.open": "View",

    "plugin.strix-security.confirm.deleteRun.title": "Delete this scan?",
    "plugin.strix-security.confirm.deleteRun.message":
      "Removes the run for {target}, its findings, and its on-disk report — including any proof-of-concept exploits. This cannot be undone.",
    "plugin.strix-security.confirm.deleteRun.confirm": "Delete",
    "plugin.strix-security.confirm.clearAll.title": "Clear all scans?",
    "plugin.strix-security.confirm.clearAll.message":
      "Deletes all {count} runs, their findings, every triage decision, and every on-disk report. This cannot be undone.",
    "plugin.strix-security.confirm.clearAll.confirm": "Clear all",

    "plugin.strix-security.toast.scanDone": "Scan finished — {count} findings",
    "plugin.strix-security.toast.scanFailed": "Scan failed",
    "plugin.strix-security.toast.scanCancelled": "Scan cancelled",

    "plugin.strix-security.status.running": "Running",
    "plugin.strix-security.status.done": "Done",
    "plugin.strix-security.status.error": "Error",
    "plugin.strix-security.status.cancelled": "Cancelled",
  },
  "zh-CN": {
    "plugin.strix-security.panel.title": "安全扫描",
    "plugin.strix-security.panel.tab.scan": "扫描",
    "plugin.strix-security.panel.tab.history": "历史",

    "plugin.strix-security.preflight.checking": "正在检查环境…",
    "plugin.strix-security.preflight.ready": "Docker 与 strix 已就绪。",
    "plugin.strix-security.preflight.dockerMissing":
      "无法连接 Docker 守护进程。请启动 Docker 后重新检查。",
    "plugin.strix-security.preflight.strixMissing": "未在 PATH 中找到 strix 命令行工具。",
    "plugin.strix-security.preflight.install":
      "用 `pipx install strix-agent` 安装 Strix，并启动 Docker，然后重新检查。",
    "plugin.strix-security.preflight.retry": "重新检查",
    "plugin.strix-security.preflight.strixVersion": "strix {version}",

    "plugin.strix-security.form.targetLabel": "目标",
    "plugin.strix-security.form.targetPlaceholder": "https://example.com 或 ./local-app",
    "plugin.strix-security.form.advanced": "高级选项",
    "plugin.strix-security.form.modelLabel": "模型覆盖（可选）",
    "plugin.strix-security.form.modelPlaceholder": "如 openai/gpt-5 — 留空则用 shell 的 STRIX_LLM",
    "plugin.strix-security.form.apiKeyLabel": "API key 覆盖（可选，不保存）",
    "plugin.strix-security.form.apiKeyPlaceholder": "仅本次扫描使用的 LLM_API_KEY",
    "plugin.strix-security.form.authLabel": "我已获授权对该目标进行渗透测试。",
    "plugin.strix-security.form.authWarning":
      "Strix 会主动攻击目标。仅可扫描你拥有或已获明确授权的系统——未授权测试可能违法。",
    "plugin.strix-security.form.start": "开始扫描",
    "plugin.strix-security.form.cancel": "取消",
    "plugin.strix-security.form.targetRequired": "请输入要扫描的目标。",

    "plugin.strix-security.console.title": "输出",
    "plugin.strix-security.console.empty": "扫描输出将在此处实时显示。",
    "plugin.strix-security.console.truncated": "较早的输出已被丢弃——仅显示最新输出。",

    "plugin.strix-security.run.scanning": "正在扫描 {target}——完成后将显示漏洞。",
    "plugin.strix-security.run.failed": "扫描失败",
    "plugin.strix-security.run.cancelled": "扫描已取消",

    "plugin.strix-security.findings.none": "未发现漏洞。",
    "plugin.strix-security.findings.count": "{count} 个漏洞",
    "plugin.strix-security.findings.filter.all": "全部 {count}",
    "plugin.strix-security.findings.filter.open": "待处理 {count}",
    "plugin.strix-security.findings.filterEmpty": "此筛选下没有漏洞。",

    "plugin.strix-security.severity.critical": "{count} 严重",
    "plugin.strix-security.severity.high": "{count} 高危",
    "plugin.strix-security.severity.medium": "{count} 中危",
    "plugin.strix-security.severity.low": "{count} 低危",
    "plugin.strix-security.severity.info": "{count} 信息",

    "plugin.strix-security.finding.impact": "影响",
    "plugin.strix-security.finding.technical": "技术分析",
    "plugin.strix-security.finding.poc": "复现验证",
    "plugin.strix-security.finding.remediation": "修复建议",
    "plugin.strix-security.finding.locations": "代码位置",
    "plugin.strix-security.finding.locationUnknown": "未知位置",
    "plugin.strix-security.finding.cvss": "CVSS {score}",

    "plugin.strix-security.triage.label": "处置",
    "plugin.strix-security.triage.state.open": "待处理",
    "plugin.strix-security.triage.state.accepted": "已接受风险",
    "plugin.strix-security.triage.state.false-positive": "误报",
    "plugin.strix-security.triage.state.fixed": "已修复",
    "plugin.strix-security.triage.suppressed": "已静默",
    "plugin.strix-security.triage.muteRule": "静默全部 {rule}",
    "plugin.strix-security.triage.unmuteRule": "取消静默 {rule}",
    "plugin.strix-security.triage.mutedCount": "{count} 项已静默",

    "plugin.strix-security.export.sarif": "导出 SARIF",

    "plugin.strix-security.history.title": "扫描历史",
    "plugin.strix-security.history.empty": "暂无扫描记录。",
    "plugin.strix-security.history.findingsCount": "{count} 个漏洞",
    "plugin.strix-security.history.delete": "删除",
    "plugin.strix-security.history.deleteRunningDisabled": "请先停止扫描再删除",
    "plugin.strix-security.history.clearAll": "全部清除",
    "plugin.strix-security.history.open": "查看",

    "plugin.strix-security.confirm.deleteRun.title": "删除该次扫描？",
    "plugin.strix-security.confirm.deleteRun.message":
      "将删除 {target} 的扫描记录、漏洞及其磁盘报告（含复现脚本），不可撤销。",
    "plugin.strix-security.confirm.deleteRun.confirm": "删除",
    "plugin.strix-security.confirm.clearAll.title": "清除全部扫描？",
    "plugin.strix-security.confirm.clearAll.message":
      "将删除全部 {count} 条扫描记录、所有漏洞、全部处置决定及磁盘报告，不可撤销。",
    "plugin.strix-security.confirm.clearAll.confirm": "全部清除",

    "plugin.strix-security.toast.scanDone": "扫描完成——{count} 个漏洞",
    "plugin.strix-security.toast.scanFailed": "扫描失败",
    "plugin.strix-security.toast.scanCancelled": "扫描已取消",

    "plugin.strix-security.status.running": "运行中",
    "plugin.strix-security.status.done": "完成",
    "plugin.strix-security.status.error": "错误",
    "plugin.strix-security.status.cancelled": "已取消",
  },
} as const
