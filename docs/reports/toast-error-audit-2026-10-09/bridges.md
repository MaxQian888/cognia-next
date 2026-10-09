# 动态分发与通知桥接索引

包括成功、信息、警告、错误和诊断事件，不可把下面行数直接当成 toast 错误数。普通通知、诊断源、插件 UI host、native toast 和 OS 通知都可能出现在这里，应根据 importSource 与 levelExpression 判断是否实际呈现为 toast。

## components/inbox/adapter-health-badge.tsx:67

[components/inbox/adapter-health-badge.tsx](/Users/bytedance/Project/cognia-next/components/inbox/adapter-health-badge.tsx:67)；callee: dynamic；level: dynamic

```tsx
toast[ok ? "success" : "error"](ok ? t("reconnectQueued") : t("reconnectUnavailable"))
```

## components/issues/issue-console.tsx:464

[components/issues/issue-console.tsx](/Users/bytedance/Project/cognia-next/components/issues/issue-console.tsx:464)；callee: dynamic；level: dynamic

```tsx
toast[level](message)
```

## components/issues/projects/project-console.tsx:143

[components/issues/projects/project-console.tsx](/Users/bytedance/Project/cognia-next/components/issues/projects/project-console.tsx:143)；callee: dynamic；level: dynamic

```tsx
toast[level](message)
```

## components/plugins/plugin-error-toaster.tsx:57

[components/plugins/plugin-error-toaster.tsx](/Users/bytedance/Project/cognia-next/components/plugins/plugin-error-toaster.tsx:57)；callee: error|warning；level: error\|warning

```tsx
toastFn(title, {
  description,
  id: key,
  duration: detail.recoverable ? 6_000 : 8_000,
  action: {
    label: tLifecycle("viewDetails"),
    onClick: () => router.push(pluginDetailHref(detail.pluginId)),
  },
})
```

## components/plugins/vscode/vscode-window-presenter.tsx:88

[components/plugins/vscode/vscode-window-presenter.tsx](/Users/bytedance/Project/cognia-next/components/plugins/vscode/vscode-window-presenter.tsx:88)；callee: custom；level: custom

```tsx
toast.custom(
  (id) =>
    createElement(VscodeMessageToast, {
      request,
      onChoose: (index) => {
        settle(index)
        toast.dismiss(id)
      },
    }),
  {
    unstyled: true,
    // A message that asks something waits for the answer.
    duration: request.items.length > 0 ? Number.POSITIVE_INFINITY : MESSAGE_TOAST_MS,
    onDismiss: () => settle(null),
    onAutoClose: () => settle(null),
  }
)
```

## components/plugins/vscode/vscode-window-presenter.tsx:139

[components/plugins/vscode/vscode-window-presenter.tsx](/Users/bytedance/Project/cognia-next/components/plugins/vscode/vscode-window-presenter.tsx:139)；callee: custom；level: custom

```tsx
toast.custom(
  () =>
    createElement(VscodeProgressToast, {
      handle,
      onCancel: () => cancelProgress(pluginId, handle),
    }),
  { id: handle, unstyled: true, duration: Number.POSITIVE_INFINITY, dismissible: false }
)
```

## components/plugins/vscode/vscode-window-presenter.tsx:175

[components/plugins/vscode/vscode-window-presenter.tsx](/Users/bytedance/Project/cognia-next/components/plugins/vscode/vscode-window-presenter.tsx:175)；callee: custom；level: custom

```tsx
toast.custom(
  (id) =>
    createElement(VscodeOutputToast, {
      pluginId,
      channel,
      onOpenLogs: () => {
        requestPluginNavigation(pluginId, buildPluginLogsHref({ pluginId }))
        toast.dismiss(id)
      },
      onDismiss: () => toast.dismiss(id),
    }),
  { unstyled: true, duration: MESSAGE_TOAST_MS }
)
```

## components/providers/initializers/update-center-initializer.tsx:136

[components/providers/initializers/update-center-initializer.tsx](/Users/bytedance/Project/cognia-next/components/providers/initializers/update-center-initializer.tsx:136)；callee: success|warning；level: success\|warning

```tsx
notify(message, {
  action: { label: tRef.current("toast.open"), onClick: () => openUpdateCenter() },
})
```

## lib/notifications/runtime.ts:162

[lib/notifications/runtime.ts](/Users/bytedance/Project/cognia-next/lib/notifications/runtime.ts:162)；callee: custom；level: custom

```tsx
toast.custom(
  (id) =>
    createElement(FunctionalToastCard, {
      rec,
      onAction: (action) => {
        if (action.notificationAction) {
          void dispatchNotificationCommand({
            notificationId: rec.id,
            command: action.notificationAction.command,
            args: action.notificationAction.args,
          })
        }
        toast.dismiss(id)
      },
      onDismiss: () => toast.dismiss(id),
    }),
  { unstyled: true, duration: FUNCTIONAL_TOAST_DURATION_MS }
)
```

## lib/notifications/runtime.ts:191

[lib/notifications/runtime.ts](/Users/bytedance/Project/cognia-next/lib/notifications/runtime.ts:191)；callee: error|info|success|warning；level: error\|info\|success\|warning

```tsx
fn(rec.title, {
  description: rec.body,
  action: first
    ? {
        label: first.label,
        onClick: () =>
          void dispatchNotificationCommand({
            notificationId: rec.id,
            command: first.command,
            args: first.args,
          }),
      }
    : undefined,
})
```

## components/app-shell-mobile.tsx:459

[components/app-shell-mobile.tsx](/Users/bytedance/Project/cognia-next/components/app-shell-mobile.tsx:459)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/chat/composer.tsx:2207

[components/chat/composer.tsx](/Users/bytedance/Project/cognia-next/components/chat/composer.tsx:2207)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/chat/composer.tsx:2231

[components/chat/composer.tsx](/Users/bytedance/Project/cognia-next/components/chat/composer.tsx:2231)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/chat/composer.tsx:2238

[components/chat/composer.tsx](/Users/bytedance/Project/cognia-next/components/chat/composer.tsx:2238)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/connectivity/pair/discover-step.tsx:137

[components/connectivity/pair/discover-step.tsx](/Users/bytedance/Project/cognia-next/components/connectivity/pair/discover-step.tsx:137)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/connectivity/pair/discover-step.tsx:142

[components/connectivity/pair/discover-step.tsx](/Users/bytedance/Project/cognia-next/components/connectivity/pair/discover-step.tsx:142)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("success")
```

## components/connectivity/pair/pair-step.tsx:349

[components/connectivity/pair/pair-step.tsx](/Users/bytedance/Project/cognia-next/components/connectivity/pair/pair-step.tsx:349)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("success")
```

## components/desktop/title-bar.tsx:152

[components/desktop/title-bar.tsx](/Users/bytedance/Project/cognia-next/components/desktop/title-bar.tsx:152)；callee: notify；level:

```tsx
notify()
```

## components/error/diagnostic-notifier.tsx:73

[components/error/diagnostic-notifier.tsx](/Users/bytedance/Project/cognia-next/components/error/diagnostic-notifier.tsx:73)；callee: notify；level: ；import: @/lib/notifications/runtime

```tsx
notify(
  toNotificationInput(diagnostic, {
    ...(origin ? { origin } : {}),
    resolveTitle: () => (tr.has(labelKey) ? tr(labelKey) : diagnostic.code),
    resolveActionLabel: (kind: DiagnosticActionKind) => {
      const key = `action.${actionI18nKey(kind)}`
      return tr.has(key) ? tr(key) : kind
    },
    isActionExecutable: (kind: DiagnosticActionKind) =>
      hasNotificationCommand(diagnosticActionCommand(kind)),
    ...(decision.collapsed
      ? { collapsed: true, collapsedTitle: tr("surface.cascade", { count: recent.length }) }
      : {}),
  })
)
```

## components/mobile/chat/composer-plus-menu.tsx:337

[components/mobile/chat/composer-plus-menu.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/composer-plus-menu.tsx:337)；callee: showToast；level: ；import: @/lib/capacitor/toast

```tsx
showToast({ text: t("permissionDeniedCamera") })
```

## components/mobile/chat/message-action-sheet.tsx:243

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:243)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("success")
```

## components/mobile/chat/message-action-sheet.tsx:247

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:247)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/mobile/chat/message-action-sheet.tsx:265

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:265)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("success")
```

## components/mobile/chat/message-action-sheet.tsx:269

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:269)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/mobile/chat/message-action-sheet.tsx:307

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:307)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/mobile/chat/message-action-sheet.tsx:336

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:336)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("success")
```

## components/mobile/chat/message-action-sheet.tsx:340

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:340)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/mobile/chat/message-action-sheet.tsx:353

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:353)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("success")
```

## components/mobile/chat/message-action-sheet.tsx:356

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:356)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/mobile/chat/message-action-sheet.tsx:359

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:359)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/mobile/chat/message-action-sheet.tsx:386

[components/mobile/chat/message-action-sheet.tsx](/Users/bytedance/Project/cognia-next/components/mobile/chat/message-action-sheet.tsx:386)；callee: notify；level: ；import: @/lib/capacitor/haptics

```tsx
notify("error")
```

## components/plugins/detail/plugin-triggers-tab.tsx:54

[components/plugins/detail/plugin-triggers-tab.tsx](/Users/bytedance/Project/cognia-next/components/plugins/detail/plugin-triggers-tab.tsx:54)；callee: notify；level:

```tsx
notify()
```

## components/plugins/detail/plugin-triggers-tab.tsx:58

[components/plugins/detail/plugin-triggers-tab.tsx](/Users/bytedance/Project/cognia-next/components/plugins/detail/plugin-triggers-tab.tsx:58)；callee: notify；level:

```tsx
notify()
```

## components/providers/agent-execution-handle-provider.tsx:24

[components/providers/agent-execution-handle-provider.tsx](/Users/bytedance/Project/cognia-next/components/providers/agent-execution-handle-provider.tsx:24)；callee: notify；level:

```tsx
notify()
```

## components/providers/agent-execution-handle-provider.tsx:29

[components/providers/agent-execution-handle-provider.tsx](/Users/bytedance/Project/cognia-next/components/providers/agent-execution-handle-provider.tsx:29)；callee: notify；level:

```tsx
notify()
```

## components/providers/initializers/approval-journal-initializer.tsx:45

[components/providers/initializers/approval-journal-initializer.tsx](/Users/bytedance/Project/cognia-next/components/providers/initializers/approval-journal-initializer.tsx:45)；callee: notify；level: "warning"

```tsx
notify({
  source: "session",
  level: "warning",
  title: t("interruptedOnBoot", { count: fresh.length }),
  channels: ["center", "toast"],
  dedupeKey: "approval-journal-interrupted-boot",
})
```

## components/providers/initializers/background-task-initializer.tsx:52

[components/providers/initializers/background-task-initializer.tsx](/Users/bytedance/Project/cognia-next/components/providers/initializers/background-task-initializer.tsx:52)；callee: notify；level: "info"

```tsx
notify({
  source: "session",
  level: "info",
  title: t("autoResumed", { count }),
  channels: ["center", "toast"],
  dedupeKey: "background-auto-resume",
})
```

## components/providers/initializers/editor-lsp-runtime-initializer.tsx:26

[components/providers/initializers/editor-lsp-runtime-initializer.tsx](/Users/bytedance/Project/cognia-next/components/providers/initializers/editor-lsp-runtime-initializer.tsx:26)；callee: notify；level:

```tsx
notify()
```

## components/providers/initializers/router-fusion-initializer.tsx:58

[components/providers/initializers/router-fusion-initializer.tsx](/Users/bytedance/Project/cognia-next/components/providers/initializers/router-fusion-initializer.tsx:58)；callee: notify；level: "warning"

```tsx
notify({
  source: "system",
  level: "warning",
  title: t("breakerToast.title", {
    surface: t(`settings.surface.${surface}.label` as never),
  }),
  body: t("breakerToast.body", { reason: trip.reason }),
  channels: ["center", "toast"],
  dedupeKey: `router-fusion-breaker-${surface}`,
  href: settingsHref("ai-connections"),
})
```

## components/settings/connections/adapters/tabs/health-detail.tsx:83

[components/settings/connections/adapters/tabs/health-detail.tsx](/Users/bytedance/Project/cognia-next/components/settings/connections/adapters/tabs/health-detail.tsx:83)；callee: notify；level:

```tsx
notify()
```

## components/settings/desktop-section.tsx:166

[components/settings/desktop-section.tsx](/Users/bytedance/Project/cognia-next/components/settings/desktop-section.tsx:166)；callee: notify；level:

```tsx
notify({
  title: t("notificationTitle"),
  body: t("notificationBody"),
})
```

## components/support/report-problem-dialog.tsx:370

[components/support/report-problem-dialog.tsx](/Users/bytedance/Project/cognia-next/components/support/report-problem-dialog.tsx:370)；callee: deliver；level:

```tsx
deliver(channel.id)
```

## hooks/chat/background-result-runtime.ts:251

[hooks/chat/background-result-runtime.ts](/Users/bytedance/Project/cognia-next/hooks/chat/background-result-runtime.ts:251)；callee: notify；level: entry.status === "done" ? "success" : "error"

```tsx
notify({
  source: "session",
  level: entry.status === "done" ? "success" : "error",
  title,
  body,
  channels: ["center", "toast"],
  groupKey: runId,
  sourceRef: { kind: "background-run", id: runId },
  directed: true,
})
```

## hooks/chat/use-claude-chat-controller.ts:1769

[hooks/chat/use-claude-chat-controller.ts](/Users/bytedance/Project/cognia-next/hooks/chat/use-claude-chat-controller.ts:1769)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("turnRouteWhileBusy", {
    source: "chat",
    meta: { sessionId, extra: { handle: turnRoute.handle } },
  })
)
```

## hooks/chat/use-claude-chat-controller.ts:4075

[hooks/chat/use-claude-chat-controller.ts](/Users/bytedance/Project/cognia-next/hooks/chat/use-claude-chat-controller.ts:4075)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("fallbackToBuiltin", {
    source: "external-agent",
    message,
    meta: { sessionId, agentId: extAgentId },
  })
)
```

## hooks/chat/use-session-notifications.ts:79

[hooks/chat/use-session-notifications.ts](/Users/bytedance/Project/cognia-next/hooks/chat/use-session-notifications.ts:79)；callee: deliver；level: focused

```tsx
deliver(event, focused, tRef.current)
```

## hooks/chat/use-session-notifications.ts:107

[hooks/chat/use-session-notifications.ts](/Users/bytedance/Project/cognia-next/hooks/chat/use-session-notifications.ts:107)；callee: notify；level: "warning"；import: @/lib/notifications/runtime

```tsx
notify({
  ...common,
  level: "warning",
  title: t("approvalTitle"),
  body: named("approvalBody", "approvalBodyUnnamed"),
  // Work is blocked on a person, which is what the numeric badge counts.
  directed: true,
  dedupeKey: `session-approval:${event.sessionId}`,
})
```

## hooks/chat/use-session-notifications.ts:119

[hooks/chat/use-session-notifications.ts](/Users/bytedance/Project/cognia-next/hooks/chat/use-session-notifications.ts:119)；callee: notify；level: errored ? "error" : "success"；import: @/lib/notifications/runtime

```tsx
notify({
  ...common,
  level: errored ? "error" : "success",
  title: errored ? t("errorTitle") : t("readyTitle"),
  body: errored
    ? event.errorMessage || named("errorBodyNamed", "errorBody")
    : named("readyBodyNamed", "readyBody"),
})
```

## hooks/codeserver/use-code-server-project-opener.ts:119

[hooks/codeserver/use-code-server-project-opener.ts](/Users/bytedance/Project/cognia-next/hooks/codeserver/use-code-server-project-opener.ts:119)；callee: codeServerClient.notify；level: message

```tsx
codeServerClient.notify(root, message, kind)
```

## hooks/context-workbench/use-panel-history.ts:75

[hooks/context-workbench/use-panel-history.ts](/Users/bytedance/Project/cognia-next/hooks/context-workbench/use-panel-history.ts:75)；callee: notify；level:

```tsx
notify()
```

## hooks/context-workbench/use-panel-history.ts:83

[hooks/context-workbench/use-panel-history.ts](/Users/bytedance/Project/cognia-next/hooks/context-workbench/use-panel-history.ts:83)；callee: notify；level:

```tsx
notify()
```

## hooks/context-workbench/use-panel-history.ts:92

[hooks/context-workbench/use-panel-history.ts](/Users/bytedance/Project/cognia-next/hooks/context-workbench/use-panel-history.ts:92)；callee: notify；level:

```tsx
notify()
```

## hooks/context-workbench/use-panel-history.ts:119

[hooks/context-workbench/use-panel-history.ts](/Users/bytedance/Project/cognia-next/hooks/context-workbench/use-panel-history.ts:119)；callee: notify；level:

```tsx
notify()
```

## hooks/context-workbench/use-panel-history.ts:125

[hooks/context-workbench/use-panel-history.ts](/Users/bytedance/Project/cognia-next/hooks/context-workbench/use-panel-history.ts:125)；callee: notify；level:

```tsx
notify()
```

## hooks/git/use-git-read.ts:91

[hooks/git/use-git-read.ts](/Users/bytedance/Project/cognia-next/hooks/git/use-git-read.ts:91)；callee: deliver；level:

```tsx
deliver(data)
```

## hooks/inbox/use-im-configured.ts:35

[hooks/inbox/use-im-configured.ts](/Users/bytedance/Project/cognia-next/hooks/inbox/use-im-configured.ts:35)；callee: notify；level:

```tsx
notify()
```

## hooks/inbox/use-im-configured.ts:41

[hooks/inbox/use-im-configured.ts](/Users/bytedance/Project/cognia-next/hooks/inbox/use-im-configured.ts:41)；callee: notify；level:

```tsx
notify()
```

## hooks/plugins/use-plugin-rollback-availability.ts:48

[hooks/plugins/use-plugin-rollback-availability.ts](/Users/bytedance/Project/cognia-next/hooks/plugins/use-plugin-rollback-availability.ts:48)；callee: notify；level:

```tsx
notify()
```

## hooks/sandbox/use-sandbox-placement.ts:87

[hooks/sandbox/use-sandbox-placement.ts](/Users/bytedance/Project/cognia-next/hooks/sandbox/use-sandbox-placement.ts:87)；callee: notify；level:

```tsx
notify()
```

## hooks/sandbox/use-sandbox-placement.ts:100

[hooks/sandbox/use-sandbox-placement.ts](/Users/bytedance/Project/cognia-next/hooks/sandbox/use-sandbox-placement.ts:100)；callee: notify；level:

```tsx
notify()
```

## hooks/use-host-profile.ts:93

[hooks/use-host-profile.ts](/Users/bytedance/Project/cognia-next/hooks/use-host-profile.ts:93)；callee: notify；level:

```tsx
notify()
```

## lib/account-sync/approval-notifications.ts:42

[lib/account-sync/approval-notifications.ts](/Users/bytedance/Project/cognia-next/lib/account-sync/approval-notifications.ts:42)；callee: notify；level: "warning"；import: @/lib/notifications/runtime

```tsx
notify({
  source: "system",
  level: "warning",
  title: text.title,
  body: text.body,
  channels: [...APPROVAL_CHANNELS],
  dedupeKey: key,
  logicalKey: key,
  directed: true,
  validUntil: request.expiresAt,
  icon: "smartphone",
  actions: [
    {
      id: "open",
      label: text.open,
      command: OPEN_APPROVAL_COMMAND,
      args: { requestId: request.requestId },
      variant: "primary",
    },
  ],
})
```

## lib/agent/plan/notify.ts:88

[lib/agent/plan/notify.ts](/Users/bytedance/Project/cognia-next/lib/agent/plan/notify.ts:88)；callee: notify；level:

```tsx
notify(input)
```

## lib/ai/agent/external/runtimes/acp/acp-dynamic-mcp-controller.ts:71

[lib/ai/agent/external/runtimes/acp/acp-dynamic-mcp-controller.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/external/runtimes/acp/acp-dynamic-mcp-controller.ts:71)；callee: context.notify；level:

```tsx
context.notify({
  connectionId,
  method: notification.method,
  ...(notification.params ? { params: notification.params } : {}),
})
```

## lib/ai/agent/external/runtimes/acp/acp-sdk-conformance-harness.ts:44

[lib/ai/agent/external/runtimes/acp/acp-sdk-conformance-harness.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/external/runtimes/acp/acp-sdk-conformance-harness.ts:44)；callee: clientContext.notify；level: { sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "message-1", content: { type: "text", text: "conformant" }, }, }

```tsx
clientContext.notify(methods.client.session.update, {
  sessionId: params.sessionId,
  update: {
    sessionUpdate: "agent_message_chunk",
    messageId: "message-1",
    content: { type: "text", text: "conformant" },
  },
})
```

## lib/ai/agent/team/agent-team-runtime-deps.ts:248

[lib/ai/agent/team/agent-team-runtime-deps.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime-deps.ts:248)；callee: notify；level: p.level === "warn" ? "warning" : p.level === "critical" ? "critical" : "info"

```tsx
notify({
  source: "agent-team",
  level: p.level === "warn" ? "warning" : p.level === "critical" ? "critical" : "info",
  title: p.title,
  body: p.body,
  href: p.detailHref,
  dedupeKey: p.dedupeKey,
  groupKey: p.runId,
  sourceRef: { kind: "team-run", id: p.runId },
  directed: p.level === "critical",
})
```

## lib/ai/agent/team/agent-team-runtime.ts:576

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:576)；callee: notifier.notify；level: "critical"

```tsx
notifier.notify({
  level: "critical",
  title: "Stale capabilities detected",
  body: `${auditWarnings.length} capability reference(s) no longer resolve (a contributing plugin may be disabled). Review the run to continue or cancel.`,
  runId,
  teamId,
  dedupeKey: `capability-audit:${runId}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:585

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:585)；callee: notifier.notify；level: "warn"

```tsx
notifier.notify({
  level: "warn",
  title: "Proceeding with stale capabilities",
  body: `${auditWarnings.length} capability reference(s) no longer resolve; the ${origin} run continues without them (headless policy).`,
  runId,
  teamId,
  dedupeKey: `capability-audit:${runId}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:650

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:650)；callee: notifier.notify；level: "critical"

```tsx
notifier.notify({
  level: "critical",
  title: "Headless run blocked by plan approval",
  body: reason,
  runId,
  teamId,
  dedupeKey: `plan-approval-headless:${runId}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:690

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:690)；callee: notifier.notify；level: "critical"

```tsx
notifier.notify({
  level: "critical",
  title: "Lead planning failed",
  body: reason,
  runId,
  teamId,
  dedupeKey: `plan-failed:${runId}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:708

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:708)；callee: notifier.notify；level: "critical"

```tsx
notifier.notify({
  level: "critical",
  title: "Plan awaiting approval",
  body: gateIsRiskOnly
    ? `This run touches ${riskAssessment.reason}, so approval is required. Review the lead's plan, or reject with feedback for another revision.`
    : "The lead proposed a plan. Approve to start the run, or reject with feedback for another revision.",
  runId,
  teamId,
  dedupeKey: `plan-approval:${runId}:${i}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:826

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:826)；callee: notifier.notify；level: "info"

```tsx
notifier.notify({
  level: "info",
  title: `Resuming after rate-limit cooldown`,
  body: `${member?.name ?? memberId} is being nudged to continue.`,
  runId,
  teamId,
  dedupeKey: `nudge:${runId}:${memberId}:${generation}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:887

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:887)；callee: notifier.notify；level: "info"

```tsx
notifier.notify({
  level: "info",
  title: `Teammate disqualified: ${tm?.name ?? teammateId}`,
  body: `Reason: ${reason}. Headless ${origin} run continues on the remaining teammates.`,
  runId,
  teamId,
  dedupeKey: `teammate-fix:${runId}:${teammateId}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:897

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:897)；callee: notifier.notify；level: "critical"

```tsx
notifier.notify({
  level: "critical",
  title: `Teammate disqualified: ${tm?.name ?? teammateId}`,
  body: `Reason: ${reason}. Fix configuration and rejoin, or skip.`,
  runId,
  teamId,
  dedupeKey: `teammate-fix:${runId}:${teammateId}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:1024

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:1024)；callee: notifier.notify；level: "warn"

```tsx
notifier.notify({
  level: "warn",
  title: "Workspace promotion requires review",
  body: `The ${isoCfg.reconcile} reconcile mode is not applied automatically to detached Registry environments. Review and promote the result explicitly.`,
  runId,
  teamId,
  dedupeKey: `wsiso-promotion:${runId}`,
})
```

## lib/ai/agent/team/agent-team-runtime.ts:1038

[lib/ai/agent/team/agent-team-runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/agent-team-runtime.ts:1038)；callee: notifier.notify；level: "warn"

```tsx
notifier.notify({
  level: "warn",
  title: "PR feedback awaits branch promotion",
  body: "Detached Registry environments do not create pull-request branches automatically.",
  runId,
  teamId,
  dedupeKey: `prfeedback-promotion:${runId}`,
})
```

## lib/ai/agent/team/auto/handoff.ts:81

[lib/ai/agent/team/auto/handoff.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/auto/handoff.ts:81)；callee: notify；level:

```tsx
notify(input)
```

## lib/ai/agent/team/durable/rate-limit-resume.ts:119

[lib/ai/agent/team/durable/rate-limit-resume.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/durable/rate-limit-resume.ts:119)；callee: this.deps.deliver；level:

```tsx
this.deps.deliver({ memberId, fingerprint, generation })
```

## lib/ai/agent/team/durable/replan-checkpoint.ts:187

[lib/ai/agent/team/durable/replan-checkpoint.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/durable/replan-checkpoint.ts:187)；callee: teamCtx.notifier.notify；level: "info"

```tsx
teamCtx.notifier.notify({
  level: "info",
  title: `Re-plan: ${decision.action}`,
  body: decision.reasoning,
  runId,
  teamId: teamCtx.teamId,
})
```

## lib/ai/agent/team/durable/replan-checkpoint.ts:218

[lib/ai/agent/team/durable/replan-checkpoint.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/durable/replan-checkpoint.ts:218)；callee: teamCtx.notifier.notify；level: "info"

```tsx
teamCtx.notifier.notify({
  level: "info",
  title: `Recruited teammate: ${created.name}`,
  body: nm.twinId ? `Digital employee bound (${nm.twinId}).` : "New generalist member.",
  runId,
  teamId: teamCtx.teamId,
})
```

## lib/ai/agent/team/gates/budget-guard.ts:95

[lib/ai/agent/team/gates/budget-guard.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/gates/budget-guard.ts:95)；callee: opts.notifier.notify；level: "critical"

```tsx
opts.notifier.notify({
  level: "critical",
  title: "Token budget critical",
  body: `Used ${used} of ${limit} tokens (${((used / limit) * 100).toFixed(1)}%)`,
  runId: opts.runId,
  teamId: "",
  dedupeKey: `budget-critical:${opts.runId}`,
})
```

## lib/ai/agent/team/gates/budget-guard.ts:113

[lib/ai/agent/team/gates/budget-guard.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/gates/budget-guard.ts:113)；callee: opts.notifier.notify；level: "warn"

```tsx
opts.notifier.notify({
  level: "warn",
  title: "Concurrency reduced to 1",
  body: "Budget critical; further tasks will serialize.",
  runId: opts.runId,
  teamId: "",
  dedupeKey: `budget-reduce:${opts.runId}`,
})
```

## lib/ai/agent/team/gates/budget-guard.ts:141

[lib/ai/agent/team/gates/budget-guard.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/gates/budget-guard.ts:141)；callee: opts.notifier.notify；level: "warn"

```tsx
opts.notifier.notify({
  level: "warn",
  title: "Token budget warning",
  body: `Used ${used} of ${limit} tokens (${(ratio * 100).toFixed(1)}%)`,
  runId: opts.runId,
  teamId: "",
  dedupeKey: `budget-warning:${opts.runId}`,
})
```

## lib/ai/agent/team/gates/deadlock-gate.ts:67

[lib/ai/agent/team/gates/deadlock-gate.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/gates/deadlock-gate.ts:67)；callee: deps.notifier.notify；level: "critical"

```tsx
deps.notifier.notify({
  level: "critical",
  title: "All teammates unavailable",
  body: headless
    ? "Headless run has no operator for deadlock recovery — aborting."
    : "Deadlock recovery is disabled — aborting the run.",
  runId: deps.runId,
  teamId: deps.teamId,
  dedupeKey,
})
```

## lib/ai/agent/team/gates/deadlock-gate.ts:85

[lib/ai/agent/team/gates/deadlock-gate.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/gates/deadlock-gate.ts:85)；callee: deps.notifier.notify；level: "critical"

```tsx
deps.notifier.notify({
  level: "critical",
  title: "All teammates unavailable",
  body: "Run paused awaiting operator decision.",
  runId: deps.runId,
  teamId: deps.teamId,
  dedupeKey,
})
```

## lib/ai/agent/team/gates/replan-gate.ts:57

[lib/ai/agent/team/gates/replan-gate.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/gates/replan-gate.ts:57)；callee: notifier.notify；level: "info"

```tsx
notifier.notify({
  level: "info",
  title: "Re-plan skipped (headless run)",
  body: `Approval required but the run is headless — continuing with the original plan. Proposed change: ${decision.reasoning}`,
  runId,
  teamId,
  dedupeKey: `replan:${runId}`,
})
```

## lib/ai/agent/team/gates/replan-gate.ts:67

[lib/ai/agent/team/gates/replan-gate.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/gates/replan-gate.ts:67)；callee: notifier.notify；level: "critical"

```tsx
notifier.notify({
  level: "critical",
  title: "Re-plan checkpoint awaiting approval",
  body: decision.reasoning,
  runId,
  teamId,
  dedupeKey: `replan:${runId}`,
})
```

## lib/ai/agent/team/ledger/progress-ledger-checkpoint.ts:116

[lib/ai/agent/team/ledger/progress-ledger-checkpoint.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/ledger/progress-ledger-checkpoint.ts:116)；callee: ctx.notifier.notify；level: "warn"

```tsx
ctx.notifier.notify({
  level: "warn",
  title: `Progress ledger: ${verdict.recommendedAction}`,
  body: verdict.diagnosis,
  runId: ctx.runId,
  teamId: ctx.teamId,
})
```

## lib/ai/agent/team/pr-feedback/observer.ts:235

[lib/ai/agent/team/pr-feedback/observer.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/pr-feedback/observer.ts:235)；callee: this.deps.deliver；level: n

```tsx
this.deps.deliver(state.binding, n)
```

## lib/ai/agent/team/pr-feedback/reactions.ts:240

[lib/ai/agent/team/pr-feedback/reactions.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/pr-feedback/reactions.ts:240)；callee: ctx.deliver；level:

```tsx
ctx.deliver(nudge)
```

## lib/ai/agent/team/pr-feedback/runtime.ts:115

[lib/ai/agent/team/pr-feedback/runtime.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/pr-feedback/runtime.ts:115)；callee: notify；level: "info"

```tsx
notify({
  level: "info",
  title: "PR feedback routed",
  body: `${nameOf(binding.memberId)} was nudged to address ${nudge.category} feedback on the PR.`,
  runId,
  teamId,
  dedupeKey: `prnudge:${runId}:${nudge.key}:${nudge.generation}`,
})
```

## lib/ai/agent/team/teammate/dispatch-teammate.ts:951

[lib/ai/agent/team/teammate/dispatch-teammate.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/teammate/dispatch-teammate.ts:951)；callee: teamCtx.notifier.notify；level: "critical"

```tsx
teamCtx.notifier.notify({
  level: "critical",
  title: "Pinned external agent config unavailable",
  body: `${teammate.name} is pinned to external agent config "${error.configId}": ${error.message}`,
  runId: teamCtx.runId,
  teamId: teamCtx.teamId,
  taskId: args.taskId,
  dedupeKey: `external-binding:${teamCtx.runId}:${teammate.id}`,
})
```

## lib/ai/agent/team/teammate/dispatch-teammate.ts:981

[lib/ai/agent/team/teammate/dispatch-teammate.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/teammate/dispatch-teammate.ts:981)；callee: teamCtx.notifier.notify；level: "critical"

```tsx
teamCtx.notifier.notify({
  level: "critical",
  title: "External runtime unavailable",
  body: `${teammate.name} is configured to run on "${wantedAgent}", but that external agent is unavailable here — the task was not run on a different engine.`,
  runId: teamCtx.runId,
  teamId: teamCtx.teamId,
  taskId: args.taskId,
  dedupeKey: `external-unavailable:${teamCtx.runId}:${teammate.id}`,
})
```

## lib/ai/agent/team/teammate/dispatch-teammate.ts:1113

[lib/ai/agent/team/teammate/dispatch-teammate.ts](/Users/bytedance/Project/cognia-next/lib/ai/agent/team/teammate/dispatch-teammate.ts:1113)；callee: teamCtx.notifier.notify；level: "warn"

```tsx
teamCtx.notifier.notify({
  level: "warn",
  title: "Teammate degraded to text channel",
  body: `${teammate.name} is running without tools or sub-agent nesting — the desktop sidecar was unavailable.`,
  runId: teamCtx.runId,
  teamId: teamCtx.teamId,
  taskId: args.taskId,
  dedupeKey: `text-fallback:${teamCtx.runId}:${teammate.id}`,
})
```

## lib/ai/headless-turn-llm-client.ts:90

[lib/ai/headless-turn-llm-client.ts](/Users/bytedance/Project/cognia-next/lib/ai/headless-turn-llm-client.ts:90)；callee: notify；level:

```tsx
notify()
```

## lib/ai/headless-turn-llm-client.ts:102

[lib/ai/headless-turn-llm-client.ts](/Users/bytedance/Project/cognia-next/lib/ai/headless-turn-llm-client.ts:102)；callee: notify；level:

```tsx
notify()
```

## lib/artifacts/element-pick-registry.ts:85

[lib/artifacts/element-pick-registry.ts](/Users/bytedance/Project/cognia-next/lib/artifacts/element-pick-registry.ts:85)；callee: notify；level:

```tsx
notify()
```

## lib/artifacts/element-pick-registry.ts:89

[lib/artifacts/element-pick-registry.ts](/Users/bytedance/Project/cognia-next/lib/artifacts/element-pick-registry.ts:89)；callee: notify；level:

```tsx
notify()
```

## lib/artifacts/element-pick-registry.ts:132

[lib/artifacts/element-pick-registry.ts](/Users/bytedance/Project/cognia-next/lib/artifacts/element-pick-registry.ts:132)；callee: notify；level:

```tsx
notify()
```

## lib/capacitor/camera-recovery.ts:145

[lib/capacitor/camera-recovery.ts](/Users/bytedance/Project/cognia-next/lib/capacitor/camera-recovery.ts:145)；callee: notify；level:

```tsx
notify()
```

## lib/capacitor/camera-recovery.ts:180

[lib/capacitor/camera-recovery.ts](/Users/bytedance/Project/cognia-next/lib/capacitor/camera-recovery.ts:180)；callee: notify；level:

```tsx
notify()
```

## lib/capacitor/camera-recovery.ts:188

[lib/capacitor/camera-recovery.ts](/Users/bytedance/Project/cognia-next/lib/capacitor/camera-recovery.ts:188)；callee: notify；level:

```tsx
notify()
```

## lib/chat/session-peer-messaging.ts:86

[lib/chat/session-peer-messaging.ts](/Users/bytedance/Project/cognia-next/lib/chat/session-peer-messaging.ts:86)；callee: runtime.deliver；level:

```tsx
runtime.deliver(message)
```

## lib/chat/session-peer-messaging.ts:158

[lib/chat/session-peer-messaging.ts](/Users/bytedance/Project/cognia-next/lib/chat/session-peer-messaging.ts:158)；callee: deps.deliver；level:

```tsx
deps.deliver(row)
```

## lib/chat/session-peer-messaging.ts:231

[lib/chat/session-peer-messaging.ts](/Users/bytedance/Project/cognia-next/lib/chat/session-peer-messaging.ts:231)；callee: deliver；level: deps

```tsx
deliver(row, deps)
```

## lib/chat/session-peer-messaging.ts:264

[lib/chat/session-peer-messaging.ts](/Users/bytedance/Project/cognia-next/lib/chat/session-peer-messaging.ts:264)；callee: deliver；level: deps

```tsx
deliver(row, deps)
```

## lib/chat/session-peer-messaging.ts:286

[lib/chat/session-peer-messaging.ts](/Users/bytedance/Project/cognia-next/lib/chat/session-peer-messaging.ts:286)；callee: deliver；level: deps

```tsx
deliver(queued, deps)
```

## lib/chat/start-session.ts:307

[lib/chat/start-session.ts](/Users/bytedance/Project/cognia-next/lib/chat/start-session.ts:307)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("workspaceUnavailable", {
    source: "chat",
    message: error instanceof Error ? error.message : String(error),
  })
)
```

## lib/chat/start-session.ts:344

[lib/chat/start-session.ts](/Users/bytedance/Project/cognia-next/lib/chat/start-session.ts:344)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(createDiagnostic("hostSessionRefused", { source: "chat", message: error.code }))
```

## lib/chat/trigger-audit-ring.ts:94

[lib/chat/trigger-audit-ring.ts](/Users/bytedance/Project/cognia-next/lib/chat/trigger-audit-ring.ts:94)；callee: notify；level:

```tsx
notify()
```

## lib/chat/trigger-audit-ring.ts:141

[lib/chat/trigger-audit-ring.ts](/Users/bytedance/Project/cognia-next/lib/chat/trigger-audit-ring.ts:141)；callee: notify；level:

```tsx
notify()
```

## lib/chat/trigger-audit-ring.ts:147

[lib/chat/trigger-audit-ring.ts](/Users/bytedance/Project/cognia-next/lib/chat/trigger-audit-ring.ts:147)；callee: notify；level:

```tsx
notify()
```

## lib/claude/routing-fallback.ts:231

[lib/claude/routing-fallback.ts](/Users/bytedance/Project/cognia-next/lib/claude/routing-fallback.ts:231)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("degradedFallback", {
    source: "provider",
    meta: {
      sessionId,
      providerId: nextEntry.providerId,
      modelId: nextEntry.modelId,
      attempts: cacheUpdate.attemptIndex,
    },
  })
)
```

## lib/collab/notifications-sync.ts:458

[lib/collab/notifications-sync.ts](/Users/bytedance/Project/cognia-next/lib/collab/notifications-sync.ts:458)；callee: notify；level:

```tsx
notify(input)
```

## lib/collab/notifications-sync.ts:636

[lib/collab/notifications-sync.ts](/Users/bytedance/Project/cognia-next/lib/collab/notifications-sync.ts:636)；callee: notify；level:

```tsx
notify(collabNotificationInput(row, presentation, { ...context, quiet }))
```

## lib/collab/shared-approval-bridge.ts:95

[lib/collab/shared-approval-bridge.ts](/Users/bytedance/Project/cognia-next/lib/collab/shared-approval-bridge.ts:95)；callee: this.options.deliver；level: resolution.status === "approved" && !expired ? "allow" : "deny"

```tsx
this.options.deliver(local, resolution.status === "approved" && !expired ? "allow" : "deny")
```

## lib/companion/event-bridge.ts:183

[lib/companion/event-bridge.ts](/Users/bytedance/Project/cognia-next/lib/companion/event-bridge.ts:183)；callee: notify；level: "warning"；import: @/lib/notifications/runtime

```tsx
notify({
  source: "system",
  level: "warning",
  title: t("title"),
  body: t("body", {
    label: payload.label || payload.device_id,
    platform: normalizePlatform(payload.platform),
  }),
  href: "/devices",
  dedupeKey: `device-paired:${payload.device_id}`,
  sourceRef: { kind: "paired-device", id: payload.device_id },
  directed: true,
})
```

## lib/connectivity/mdns-discovery.ts:115

[lib/connectivity/mdns-discovery.ts](/Users/bytedance/Project/cognia-next/lib/connectivity/mdns-discovery.ts:115)；callee: notify；level:

```tsx
notify(discovered)
```

## lib/connectors/adapters/wecom/index.ts:765

[lib/connectors/adapters/wecom/index.ts](/Users/bytedance/Project/cognia-next/lib/connectors/adapters/wecom/index.ts:765)；callee: deliver；level:

```tsx
deliver(
  buildStreamWithTemplateCardFrame(
    reqId,
    streamId,
    firstMarkdown || openStreamText || "",
    primaryCard
  )
)
```

## lib/connectors/adapters/wecom/index.ts:775

[lib/connectors/adapters/wecom/index.ts](/Users/bytedance/Project/cognia-next/lib/connectors/adapters/wecom/index.ts:775)；callee: deliver；level:

```tsx
deliver(buildStreamRespondFrame(reqId, streamId, firstMarkdown, true))
```

## lib/connectors/adapters/wecom/index.ts:779

[lib/connectors/adapters/wecom/index.ts](/Users/bytedance/Project/cognia-next/lib/connectors/adapters/wecom/index.ts:779)；callee: deliver；level:

```tsx
deliver(buildStreamRespondFrame(reqId, streamId, openStreamText, true))
```

## lib/connectors/adapters/wecom/index.ts:781

[lib/connectors/adapters/wecom/index.ts](/Users/bytedance/Project/cognia-next/lib/connectors/adapters/wecom/index.ts:781)；callee: deliver；level:

```tsx
deliver(buildTemplateCardRespondFrame(reqId, primaryCard))
```

## lib/connectors/adapters/wecom/index.ts:784

[lib/connectors/adapters/wecom/index.ts](/Users/bytedance/Project/cognia-next/lib/connectors/adapters/wecom/index.ts:784)；callee: deliver；level:

```tsx
deliver(
  buildSendMsgFrame(newReqId(opts.id), {
    chatid: ref.chatId,
    chat_type: ref.chatType === "group" ? 2 : 1,
    msgtype: "markdown",
    markdown: { content },
  })
)
```

## lib/connectors/adapters/wecom/index.ts:795

[lib/connectors/adapters/wecom/index.ts](/Users/bytedance/Project/cognia-next/lib/connectors/adapters/wecom/index.ts:795)；callee: deliver；level:

```tsx
deliver(buildTemplateCardRespondFrame(reqId, card))
```

## lib/connectors/adapters/wecom/index.ts:800

[lib/connectors/adapters/wecom/index.ts](/Users/bytedance/Project/cognia-next/lib/connectors/adapters/wecom/index.ts:800)；callee: deliver；level:

```tsx
deliver({
  cmd: "aibot_respond_msg",
  headers: { req_id: reqId },
  body: { msgtype: m.type, [m.type]: { media_id: m.mediaId } },
})
```

## lib/connectors/adapters/wecom/index.ts:853

[lib/connectors/adapters/wecom/index.ts](/Users/bytedance/Project/cognia-next/lib/connectors/adapters/wecom/index.ts:853)；callee: deliver；level:

```tsx
deliver(buildSendMsgFrame(newReqId(opts.id), body))
```

## lib/connectors/assignment/notify-assignment.ts:76

[lib/connectors/assignment/notify-assignment.ts](/Users/bytedance/Project/cognia-next/lib/connectors/assignment/notify-assignment.ts:76)；callee: notify；level: input.via === "sla-escalation" ? "warning" : "info"；import: @/lib/notifications/runtime

```tsx
notify({
  source: "connector",
  level: input.via === "sla-escalation" ? "warning" : "info",
  title: notice.title,
  body: `${body}（${input.via}）`,
  channels: ["center", "toast"],
  href: assignmentHref(input.conversationKey),
  groupKey: input.conversationKey,
  dedupeKey: `assign:${input.conversationKey}`,
  sourceRef: { kind: "conversation", id: input.conversationKey },
  // "You now hold this conversation" is directed; everything else is ambient.
  directed: to?.kind === "human",
  meta: { kind, via: input.via, from, to },
})
```

## lib/connectors/escalation/actions.ts:99

[lib/connectors/escalation/actions.ts](/Users/bytedance/Project/cognia-next/lib/connectors/escalation/actions.ts:99)；callee: notify；level: "warning"

```tsx
notify({
  source: "connector",
  level: "warning",
  title: SLA_ESCALATION_NOTICE.overdue.title,
  body: SLA_ESCALATION_NOTICE.overdue.body(ctx.overdueMinutes, ctx.stepIndex),
  channels: ["center", "toast"],
  href: assignmentHref(ctx.conversationKey),
  groupKey: ctx.conversationKey,
  dedupeKey: `sla:${ctx.conversationKey}:${ctx.stepIndex}`,
  sourceRef: { kind: "conversation", id: ctx.conversationKey },
  directed: true,
  meta: { kind: "sla-escalation", step: ctx.stepIndex, overdueMinutes: ctx.overdueMinutes },
})
```

## lib/connectors/hitl/approval-registry.ts:187

[lib/connectors/hitl/approval-registry.ts](/Users/bytedance/Project/cognia-next/lib/connectors/hitl/approval-registry.ts:187)；callee: notify；level:

```tsx
notify()
```

## lib/connectors/hitl/approval-registry.ts:196

[lib/connectors/hitl/approval-registry.ts](/Users/bytedance/Project/cognia-next/lib/connectors/hitl/approval-registry.ts:196)；callee: notify；level:

```tsx
notify()
```

## lib/connectors/hitl/approval-registry.ts:215

[lib/connectors/hitl/approval-registry.ts](/Users/bytedance/Project/cognia-next/lib/connectors/hitl/approval-registry.ts:215)；callee: notify；level:

```tsx
notify()
```

## lib/connectors/hitl/ask-user-registry.ts:175

[lib/connectors/hitl/ask-user-registry.ts](/Users/bytedance/Project/cognia-next/lib/connectors/hitl/ask-user-registry.ts:175)；callee: notify；level:

```tsx
notify()
```

## lib/connectors/hitl/ask-user-registry.ts:180

[lib/connectors/hitl/ask-user-registry.ts](/Users/bytedance/Project/cognia-next/lib/connectors/hitl/ask-user-registry.ts:180)；callee: notify；level:

```tsx
notify()
```

## lib/connectors/hitl/ask-user-registry.ts:186

[lib/connectors/hitl/ask-user-registry.ts](/Users/bytedance/Project/cognia-next/lib/connectors/hitl/ask-user-registry.ts:186)；callee: notify；level:

```tsx
notify()
```

## lib/connectors/hitl/ask-user-registry.ts:210

[lib/connectors/hitl/ask-user-registry.ts](/Users/bytedance/Project/cognia-next/lib/connectors/hitl/ask-user-registry.ts:210)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/active-context.ts:163

[lib/context-workbench/active-context.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/active-context.ts:163)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/active-context.ts:167

[lib/context-workbench/active-context.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/active-context.ts:167)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/active-context.ts:185

[lib/context-workbench/active-context.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/active-context.ts:185)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/active-context.ts:193

[lib/context-workbench/active-context.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/active-context.ts:193)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/active-context.ts:210

[lib/context-workbench/active-context.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/active-context.ts:210)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/active-context.ts:423

[lib/context-workbench/active-context.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/active-context.ts:423)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/panel-registry.ts:85

[lib/context-workbench/panel-registry.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/panel-registry.ts:85)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/panel-registry.ts:101

[lib/context-workbench/panel-registry.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/panel-registry.ts:101)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/panel-registry.ts:114

[lib/context-workbench/panel-registry.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/panel-registry.ts:114)；callee: notify；level:

```tsx
notify()
```

## lib/context-workbench/panel-registry.ts:123

[lib/context-workbench/panel-registry.ts](/Users/bytedance/Project/cognia-next/lib/context-workbench/panel-registry.ts:123)；callee: notify；level:

```tsx
notify()
```

## lib/creator/executor.ts:284

[lib/creator/executor.ts](/Users/bytedance/Project/cognia-next/lib/creator/executor.ts:284)；callee: handlers.deliver；level:

```tsx
handlers.deliver(ctx)
```

## lib/db/encrypted-content-middleware.ts:313

[lib/db/encrypted-content-middleware.ts](/Users/bytedance/Project/cognia-next/lib/db/encrypted-content-middleware.ts:313)；callee: deliver；level:

```tsx
deliver(outcome.value)
```

## lib/db/schema.ts:2465

[lib/db/schema.ts](/Users/bytedance/Project/cognia-next/lib/db/schema.ts:2465)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("seedFailed", {
    source: "storage",
    message: err instanceof Error ? err.message : String(err),
  })
)
```

## lib/db/workflow-waitpoints.ts:169

[lib/db/workflow-waitpoints.ts](/Users/bytedance/Project/cognia-next/lib/db/workflow-waitpoints.ts:169)；callee: notify；level:

```tsx
notify(stored)
```

## lib/db/workflow-waitpoints.ts:209

[lib/db/workflow-waitpoints.ts](/Users/bytedance/Project/cognia-next/lib/db/workflow-waitpoints.ts:209)；callee: notify；level:

```tsx
notify(nativeCurrent)
```

## lib/db/workflow-waitpoints.ts:218

[lib/db/workflow-waitpoints.ts](/Users/bytedance/Project/cognia-next/lib/db/workflow-waitpoints.ts:218)；callee: notify；level:

```tsx
notify(winner)
```

## lib/db/workflow-waitpoints.ts:247

[lib/db/workflow-waitpoints.ts](/Users/bytedance/Project/cognia-next/lib/db/workflow-waitpoints.ts:247)；callee: notify；level:

```tsx
notify(result.waitpoint)
```

## lib/db/workflow-waitpoints.ts:306

[lib/db/workflow-waitpoints.ts](/Users/bytedance/Project/cognia-next/lib/db/workflow-waitpoints.ts:306)；callee: notify；level:

```tsx
notify(resolved)
```

## lib/file-viewer/registry.ts:41

[lib/file-viewer/registry.ts](/Users/bytedance/Project/cognia-next/lib/file-viewer/registry.ts:41)；callee: notify；level:

```tsx
notify()
```

## lib/file-viewer/registry.ts:47

[lib/file-viewer/registry.ts](/Users/bytedance/Project/cognia-next/lib/file-viewer/registry.ts:47)；callee: notify；level:

```tsx
notify()
```

## lib/file-viewer/registry.ts:98

[lib/file-viewer/registry.ts](/Users/bytedance/Project/cognia-next/lib/file-viewer/registry.ts:98)；callee: notify；level:

```tsx
notify()
```

## lib/files/project-editor-bridge.ts:364

[lib/files/project-editor-bridge.ts](/Users/bytedance/Project/cognia-next/lib/files/project-editor-bridge.ts:364)；callee: opener.notify；level: kind

```tsx
opener.notify(message, kind)
```

## lib/global-search/recents.ts:98

[lib/global-search/recents.ts](/Users/bytedance/Project/cognia-next/lib/global-search/recents.ts:98)；callee: notify；level:

```tsx
notify()
```

## lib/global-search/recents.ts:104

[lib/global-search/recents.ts](/Users/bytedance/Project/cognia-next/lib/global-search/recents.ts:104)；callee: notify；level:

```tsx
notify()
```

## lib/global-search/recents.ts:109

[lib/global-search/recents.ts](/Users/bytedance/Project/cognia-next/lib/global-search/recents.ts:109)；callee: notify；level:

```tsx
notify()
```

## lib/global-search/recents.ts:158

[lib/global-search/recents.ts](/Users/bytedance/Project/cognia-next/lib/global-search/recents.ts:158)；callee: notify；level:

```tsx
notify()
```

## lib/global-search/recents.ts:166

[lib/global-search/recents.ts](/Users/bytedance/Project/cognia-next/lib/global-search/recents.ts:166)；callee: notify；level:

```tsx
notify()
```

## lib/global-search/recents.ts:171

[lib/global-search/recents.ts](/Users/bytedance/Project/cognia-next/lib/global-search/recents.ts:171)；callee: notify；level:

```tsx
notify()
```

## lib/global-search/recents.ts:177

[lib/global-search/recents.ts](/Users/bytedance/Project/cognia-next/lib/global-search/recents.ts:177)；callee: notify；level:

```tsx
notify()
```

## lib/global-search/registry.ts:23

[lib/global-search/registry.ts](/Users/bytedance/Project/cognia-next/lib/global-search/registry.ts:23)；callee: notify；level:

```tsx
notify()
```

## lib/global-search/registry.ts:28

[lib/global-search/registry.ts](/Users/bytedance/Project/cognia-next/lib/global-search/registry.ts:28)；callee: notify；level:

```tsx
notify()
```

## lib/goal/completion-linkage.ts:81

[lib/goal/completion-linkage.ts](/Users/bytedance/Project/cognia-next/lib/goal/completion-linkage.ts:81)；callee: notify；level:

```tsx
notify({ title: `Cognia · goal ${goal.status}`, body: goal.safeObjective })
```

## lib/identity/deployment-source.ts:153

[lib/identity/deployment-source.ts](/Users/bytedance/Project/cognia-next/lib/identity/deployment-source.ts:153)；callee: notify；level:

```tsx
notify(deps)
```

## lib/identity/deployment-source.ts:163

[lib/identity/deployment-source.ts](/Users/bytedance/Project/cognia-next/lib/identity/deployment-source.ts:163)；callee: notify；level:

```tsx
notify(deps)
```

## lib/integrations/ingress-client.ts:43

[lib/integrations/ingress-client.ts](/Users/bytedance/Project/cognia-next/lib/integrations/ingress-client.ts:43)；callee: dispatchDiagnostic；level: { kind: "background" }；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("serverError", {
    source: "connector",
    message: error instanceof Error ? error.message : String(error),
    meta: {
      extra: {
        stage,
        routeId: delivery.routeId,
        deliveryId: delivery.deliveryId,
      },
    },
  }),
  { kind: "background" }
)
```

## lib/integrations/runtime.ts:17

[lib/integrations/runtime.ts](/Users/bytedance/Project/cognia-next/lib/integrations/runtime.ts:17)；callee: dispatchDiagnostic；level: { kind: "background" }；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("serverError", {
    source: "connector",
    message: error instanceof Error ? error.message : String(error),
    meta: { extra: { stage } },
  }),
  { kind: "background" }
)
```

## lib/issues/notify.ts:201

[lib/issues/notify.ts](/Users/bytedance/Project/cognia-next/lib/issues/notify.ts:201)；callee: notify；level:

```tsx
notify({ ...projected, source: "issue", sourceRef: { kind: "issue", id: issue.id } })
```

## lib/issues/notify.ts:207

[lib/issues/notify.ts](/Users/bytedance/Project/cognia-next/lib/issues/notify.ts:207)；callee: notify；level:

```tsx
notify({
  ...projected,
  // One row per conversation; the key keeps them from coalescing into each other.
  dedupeKey: `${projected.dedupeKey}:${conversationKey}`,
  source: "issue",
  channels: ["center", "im"],
  sourceRef: { kind: "conversation", id: conversationKey },
})
```

## lib/notifications/api.ts:139

[lib/notifications/api.ts](/Users/bytedance/Project/cognia-next/lib/notifications/api.ts:139)；callee: notify；level: input.level

```tsx
notify({
  source: (input.source as never) ?? "system",
  level: input.level,
  title: input.title,
  ...(input.body ? { body: input.body } : {}),
  dedupeKey: factKey,
  ...(input.runId
    ? {
        groupKey: input.runId,
        href: `/agent-runs?run=${encodeURIComponent(input.runId)}`,
        sourceRef: { kind: "run", id: input.runId },
      }
    : {}),
  logicalKey: factKey,
  category: input.category,
  directed: input.purpose === "approval-request",
  ...(input.operationKey ? { operationKey: input.operationKey } : {}),
  ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
  ...(input.scopeHint ? { scopeHint: input.scopeHint } : {}),
})
```

## lib/notifications/conversation-notify.ts:41

[lib/notifications/conversation-notify.ts](/Users/bytedance/Project/cognia-next/lib/notifications/conversation-notify.ts:41)；callee: notify；level: input.level ?? "info"；import: ./runtime

```tsx
notify({
  source: input.source ?? "connector",
  level: input.level ?? "info",
  title: input.title,
  body: input.body,
  channels: ["center", "im"],
  dedupeKey: input.dedupeKey,
  actions: input.actions,
  directed: input.directed,
  icon: input.icon,
  sourceRef: { kind: "conversation", id: input.conversationKey },
})
```

## lib/notifications/emit-center.ts:76

[lib/notifications/emit-center.ts](/Users/bytedance/Project/cognia-next/lib/notifications/emit-center.ts:76)；callee: notify；level: ；import: ./runtime

```tsx
notify(input)
```

## lib/notifications/inbound-connector.ts:60

[lib/notifications/inbound-connector.ts](/Users/bytedance/Project/cognia-next/lib/notifications/inbound-connector.ts:60)；callee: notify；level: "info"；import: ./runtime

```tsx
notify({
  source: "connector",
  level: "info",
  title,
  body,
  directed,
  href,
  channels,
  dedupeKey: event.conversationKey,
  groupKey,
  sourceRef: { kind: "conversation", id: event.conversationKey },
})
```

## lib/notifications/inbound-push.ts:67

[lib/notifications/inbound-push.ts](/Users/bytedance/Project/cognia-next/lib/notifications/inbound-push.ts:67)；callee: notify；level: ；import: ./runtime

```tsx
notify(input)
```

## lib/notifications/plugin-bridge.ts:33

[lib/notifications/plugin-bridge.ts](/Users/bytedance/Project/cognia-next/lib/notifications/plugin-bridge.ts:33)；callee: notify；level: TYPE_TO_LEVEL[type]；import: ./runtime

```tsx
notify({
  source: "plugin",
  pluginId,
  level: TYPE_TO_LEVEL[type],
  title,
  body: message,
  ttlMs: duration,
  actions,
  dedupeKey: id,
  groupKey: pluginId,
  sourceRef: { kind: "plugin", id: pluginId },
})
```

## lib/notifications/runtime.ts:82

[lib/notifications/runtime.ts](/Users/bytedance/Project/cognia-next/lib/notifications/runtime.ts:82)；callee: tauriNotify；level: ；import: @/lib/tauri/notification

```tsx
tauriNotify({ title: opts.title, body: opts.body })
```

## lib/notifications/runtime.ts:249

[lib/notifications/runtime.ts](/Users/bytedance/Project/cognia-next/lib/notifications/runtime.ts:249)；callee: notifyCore；level: buildDeps()；import: ./notify

```tsx
notifyCore(input, buildDeps())
```

## lib/observability/debug-session.ts:163

[lib/observability/debug-session.ts](/Users/bytedance/Project/cognia-next/lib/observability/debug-session.ts:163)；callee: notify；level:

```tsx
notify()
```

## lib/observability/debug-session.ts:174

[lib/observability/debug-session.ts](/Users/bytedance/Project/cognia-next/lib/observability/debug-session.ts:174)；callee: notify；level:

```tsx
notify()
```

## lib/perf/host-live-lease.ts:196

[lib/perf/host-live-lease.ts](/Users/bytedance/Project/cognia-next/lib/perf/host-live-lease.ts:196)；callee: this.notify；level:

```tsx
this.notify(subscriber)
```

## lib/perf/host-live-lease.ts:206

[lib/perf/host-live-lease.ts](/Users/bytedance/Project/cognia-next/lib/perf/host-live-lease.ts:206)；callee: this.notify；level:

```tsx
this.notify(subscriber)
```

## lib/perf/host-live-lease.ts:463

[lib/perf/host-live-lease.ts](/Users/bytedance/Project/cognia-next/lib/perf/host-live-lease.ts:463)；callee: this.deliver；level: frame

```tsx
this.deliver(subscriber, frame, held.cadenceMs)
```

## lib/perf/host-live-lease.ts:463

[lib/perf/host-live-lease.ts](/Users/bytedance/Project/cognia-next/lib/perf/host-live-lease.ts:463)；callee: this.notify；level:

```tsx
this.notify(subscriber)
```

## lib/perf/host-live-lease.ts:488

[lib/perf/host-live-lease.ts](/Users/bytedance/Project/cognia-next/lib/perf/host-live-lease.ts:488)；callee: this.deliver；level: frame

```tsx
this.deliver(subscriber, frame, leaseCadence)
```

## lib/perf/host-live-lease.ts:489

[lib/perf/host-live-lease.ts](/Users/bytedance/Project/cognia-next/lib/perf/host-live-lease.ts:489)；callee: this.notify；level:

```tsx
this.notify(subscriber)
```

## lib/perf/host-live-lease.ts:497

[lib/perf/host-live-lease.ts](/Users/bytedance/Project/cognia-next/lib/perf/host-live-lease.ts:497)；callee: this.notify；level:

```tsx
this.notify(subscriber)
```

## lib/perf/perf-hud.tsx:171

[lib/perf/perf-hud.tsx](/Users/bytedance/Project/cognia-next/lib/perf/perf-hud.tsx:171)；callee: notify；level:

```tsx
notify()
```

## lib/pet/access/notify-unavailable.ts:57

[lib/pet/access/notify-unavailable.ts](/Users/bytedance/Project/cognia-next/lib/pet/access/notify-unavailable.ts:57)；callee: notify；level: "info"

```tsx
notify({
  source: "system",
  level: "info",
  title: strings.title,
  body: strings.body,
  dedupeKey: PET_UNAVAILABLE_DEDUPE_KEY,
  href: PET_UNAVAILABLE_HREF,
  icon: "PawPrint",
  // An explanation, not a request for action: a dot, not the red badge.
  directed: false,
  ttlMs: PET_UNAVAILABLE_TTL_MS,
})
```

## lib/pet/care/notify-care.ts:42

[lib/pet/care/notify-care.ts](/Users/bytedance/Project/cognia-next/lib/pet/care/notify-care.ts:42)；callee: notify；level: "info"

```tsx
notify({
  source: "system",
  level: "info",
  title: strings.title,
  body: strings.body,
  dedupeKey: CARE_UNWELL_DEDUPE_KEY,
  icon: "Heart",
  directed: true,
})
```

## lib/pet/care/notify-scheduled-due.ts:62

[lib/pet/care/notify-scheduled-due.ts](/Users/bytedance/Project/cognia-next/lib/pet/care/notify-scheduled-due.ts:62)；callee: notify；level: "info"

```tsx
notify({
  source: "system",
  level: "info",
  title: options.title,
  body: options.body,
  channels: ["center", "toast", "os"],
  dedupeKey: scheduledDueDedupeKey(taskId),
  coalesceWindowMs: COALESCE_UNTIL_ARCHIVED,
  groupKey: SCHEDULED_DUE_GROUP_KEY,
  sourceRef: { kind: "task", id: taskId },
  icon: "Clock",
  directed: true,
  ...(options.meta ? { meta: options.meta } : {}),
  ...(options.actions ? { actions: options.actions } : {}),
  ...(options.href ? { href: options.href } : {}),
})
```

## lib/placement/degraded-audit.ts:70

[lib/placement/degraded-audit.ts](/Users/bytedance/Project/cognia-next/lib/placement/degraded-audit.ts:70)；callee: runtime.notify；level:

```tsx
runtime.notify(input)
```

## lib/placement/degraded-audit.ts:74

[lib/placement/degraded-audit.ts](/Users/bytedance/Project/cognia-next/lib/placement/degraded-audit.ts:74)；callee: notify；level: "warning"

```tsx
notify({
  source: "system",
  level: "warning",
  title,
  body,
  // One notice per authority per degrade episode, not one per cron tick —
  // an authority that is down for a day would otherwise bury the center.
  dedupeKey: `placement.degraded:${event.authorityHostId}:${event.reason}`,
  directed: true,
})
```

## lib/placement/dispatch-failure-audit.ts:103

[lib/placement/dispatch-failure-audit.ts](/Users/bytedance/Project/cognia-next/lib/placement/dispatch-failure-audit.ts:103)；callee: runtime.notify；level:

```tsx
runtime.notify(input)
```

## lib/placement/dispatch-failure-audit.ts:107

[lib/placement/dispatch-failure-audit.ts](/Users/bytedance/Project/cognia-next/lib/placement/dispatch-failure-audit.ts:107)；callee: notify；level:

```tsx
notify(describe(job, failure))
```

## lib/placement/host-dispatch-runner.ts:82

[lib/placement/host-dispatch-runner.ts](/Users/bytedance/Project/cognia-next/lib/placement/host-dispatch-runner.ts:82)；callee: deliver；level:

```tsx
deliver(job)
```

## lib/plugin/api/link-matchers.ts:178

[lib/plugin/api/link-matchers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/link-matchers.ts:178)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/link-matchers.ts:183

[lib/plugin/api/link-matchers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/link-matchers.ts:183)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/link-matchers.ts:221

[lib/plugin/api/link-matchers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/link-matchers.ts:221)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/link-matchers.ts:227

[lib/plugin/api/link-matchers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/link-matchers.ts:227)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/message-part-renderers.ts:53

[lib/plugin/api/message-part-renderers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/message-part-renderers.ts:53)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/message-part-renderers.ts:62

[lib/plugin/api/message-part-renderers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/message-part-renderers.ts:62)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/message-part-renderers.ts:81

[lib/plugin/api/message-part-renderers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/message-part-renderers.ts:81)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/message-part-renderers.ts:88

[lib/plugin/api/message-part-renderers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/message-part-renderers.ts:88)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/tool-result-renderers.ts:72

[lib/plugin/api/tool-result-renderers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/tool-result-renderers.ts:72)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/tool-result-renderers.ts:81

[lib/plugin/api/tool-result-renderers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/tool-result-renderers.ts:81)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/tool-result-renderers.ts:100

[lib/plugin/api/tool-result-renderers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/tool-result-renderers.ts:100)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/api/tool-result-renderers.ts:107

[lib/plugin/api/tool-result-renderers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/api/tool-result-renderers.ts:107)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/bridge/wallpaper-bridge.ts:164

[lib/plugin/bridge/wallpaper-bridge.ts](/Users/bytedance/Project/cognia-next/lib/plugin/bridge/wallpaper-bridge.ts:164)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/bridge/wallpaper-bridge.ts:184

[lib/plugin/bridge/wallpaper-bridge.ts](/Users/bytedance/Project/cognia-next/lib/plugin/bridge/wallpaper-bridge.ts:184)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/contracts/diagnostics-store.ts:42

[lib/plugin/contracts/diagnostics-store.ts](/Users/bytedance/Project/cognia-next/lib/plugin/contracts/diagnostics-store.ts:42)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/contracts/diagnostics-store.ts:67

[lib/plugin/contracts/diagnostics-store.ts](/Users/bytedance/Project/cognia-next/lib/plugin/contracts/diagnostics-store.ts:67)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/contracts/diagnostics-store.ts:74

[lib/plugin/contracts/diagnostics-store.ts](/Users/bytedance/Project/cognia-next/lib/plugin/contracts/diagnostics-store.ts:74)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/ide/broker-runtime.ts:951

[lib/plugin/ide/broker-runtime.ts](/Users/bytedance/Project/cognia-next/lib/plugin/ide/broker-runtime.ts:951)；callee: this.dependencies.notify；level: input.request.generation

```tsx
this.dependencies.notify(input.request.root, input.request.generation, {
  pluginId: input.params.pluginId,
  providerId: input.params.providerId,
  invocationId: input.params.invocationId,
  event: input.event,
  payload: input.payload,
})
```

## lib/plugin/ide/broker-runtime.ts:1003

[lib/plugin/ide/broker-runtime.ts](/Users/bytedance/Project/cognia-next/lib/plugin/ide/broker-runtime.ts:1003)；callee: this.dependencies.notify；level: generation

```tsx
this.dependencies.notify(input.root, generation, {
  pluginId: input.pluginId,
  providerId: input.providerId,
  event: input.event,
  payload: input.payload,
})
```

## lib/plugin/ide/protocol-runtime.ts:158

[lib/plugin/ide/protocol-runtime.ts](/Users/bytedance/Project/cognia-next/lib/plugin/ide/protocol-runtime.ts:158)；callee: this.dependencies.notify；level: input.generation

```tsx
this.dependencies.notify(input.root, input.generation, {
  pluginId: input.pluginId,
  providerId: input.server.id,
  consumerId: input.consumerId,
  event: "diagnostics",
  payload: { uri, diagnostics: markers },
})
```

## lib/plugin/ide/protocol-runtime.ts:167

[lib/plugin/ide/protocol-runtime.ts](/Users/bytedance/Project/cognia-next/lib/plugin/ide/protocol-runtime.ts:167)；callee: this.dependencies.notify；level: input.generation

```tsx
this.dependencies.notify(input.root, input.generation, {
  pluginId: input.pluginId,
  providerId: input.server.id,
  consumerId: input.consumerId,
  event: "serverRequest",
  payload: event,
})
```

## lib/plugin/ide/protocol-runtime.ts:176

[lib/plugin/ide/protocol-runtime.ts](/Users/bytedance/Project/cognia-next/lib/plugin/ide/protocol-runtime.ts:176)；callee: this.dependencies.notify；level: input.generation

```tsx
this.dependencies.notify(input.root, input.generation, {
  pluginId: input.pluginId,
  providerId: input.server.id,
  consumerId: input.consumerId,
  event: "serverNotification",
  payload: event,
})
```

## lib/plugin/ide/protocol-runtime.ts:479

[lib/plugin/ide/protocol-runtime.ts](/Users/bytedance/Project/cognia-next/lib/plugin/ide/protocol-runtime.ts:479)；callee: this.dependencies.notify；level: session.generation

```tsx
this.dependencies.notify(session.root, session.generation, {
  pluginId: session.pluginId,
  providerId: session.serverId,
  consumerId: session.consumerId,
  event: method === "protocol:message" ? "message" : "state",
  payload: params,
})
```

## lib/plugin/python/log-buffer.ts:59

[lib/plugin/python/log-buffer.ts](/Users/bytedance/Project/cognia-next/lib/plugin/python/log-buffer.ts:59)；callee: notify；level:

```tsx
notify(event.pluginId)
```

## lib/plugin/python/log-buffer.ts:81

[lib/plugin/python/log-buffer.ts](/Users/bytedance/Project/cognia-next/lib/plugin/python/log-buffer.ts:81)；callee: notify；level:

```tsx
notify(pluginId)
```

## lib/plugin/registries/character-pack-registry.ts:88

[lib/plugin/registries/character-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/plugin/registries/character-pack-registry.ts:88)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/registries/character-pack-registry.ts:104

[lib/plugin/registries/character-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/plugin/registries/character-pack-registry.ts:104)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/registries/character-pack-registry.ts:122

[lib/plugin/registries/character-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/plugin/registries/character-pack-registry.ts:122)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/registries/character-pack-registry.ts:128

[lib/plugin/registries/character-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/plugin/registries/character-pack-registry.ts:128)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/registries/character-pack-registry.ts:137

[lib/plugin/registries/character-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/plugin/registries/character-pack-registry.ts:137)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/registries/character-pack-registry.ts:158

[lib/plugin/registries/character-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/plugin/registries/character-pack-registry.ts:158)；callee: notify；level:

```tsx
notify()
```

## lib/plugin/vscode-shim/configuration-handlers.ts:162

[lib/plugin/vscode-shim/configuration-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/configuration-handlers.ts:162)；callee: deliver；level:

```tsx
deliver(pluginId)
```

## lib/plugin/vscode-shim/configuration-handlers.ts:173

[lib/plugin/vscode-shim/configuration-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/configuration-handlers.ts:173)；callee: deliver；level:

```tsx
deliver(pluginId)
```

## lib/plugin/vscode-shim/configuration-handlers.ts:226

[lib/plugin/vscode-shim/configuration-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/configuration-handlers.ts:226)；callee: deliver；level:

```tsx
deliver(pluginId)
```

## lib/plugin/vscode-shim/extensions-handlers.ts:91

[lib/plugin/vscode-shim/extensions-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/extensions-handlers.ts:91)；callee: deliver；level:

```tsx
deliver(pluginId)
```

## lib/plugin/vscode-shim/extensions-handlers.ts:102

[lib/plugin/vscode-shim/extensions-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/extensions-handlers.ts:102)；callee: deliver；level:

```tsx
deliver(pluginId)
```

## lib/plugin/vscode-shim/terminal-handlers.ts:284

[lib/plugin/vscode-shim/terminal-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/terminal-handlers.ts:284)；callee: notify；level: "terminal:closed"

```tsx
notify(entry.pluginId, "terminal:closed", {
  terminalId: entry.terminalId,
  ...(code !== null ? { code } : {}),
  reason,
})
```

## lib/plugin/vscode-shim/terminal-handlers.ts:306

[lib/plugin/vscode-shim/terminal-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/terminal-handlers.ts:306)；callee: notify；level: "terminal:interacted"

```tsx
notify(entry.pluginId, "terminal:interacted", { terminalId: entry.terminalId })
```

## lib/plugin/vscode-shim/terminal-handlers.ts:351

[lib/plugin/vscode-shim/terminal-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/terminal-handlers.ts:351)；callee: notify；level: "terminal:activeChanged"

```tsx
notify(pluginId, "terminal:activeChanged", { terminalId: active })
```

## lib/plugin/vscode-shim/terminal-handlers.ts:433

[lib/plugin/vscode-shim/terminal-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/terminal-handlers.ts:433)；callee: notify；level: "terminal:ptyInput"

```tsx
notify(pluginId, "terminal:ptyInput", { terminalId, data })
```

## lib/plugin/vscode-shim/terminal-handlers.ts:436

[lib/plugin/vscode-shim/terminal-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/terminal-handlers.ts:436)；callee: notify；level: "terminal:ptyResize"

```tsx
notify(pluginId, "terminal:ptyResize", { terminalId, columns, rows })
```

## lib/plugin/vscode-shim/webview-handlers.ts:314

[lib/plugin/vscode-shim/webview-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/webview-handlers.ts:314)；callee: deliver；level:

```tsx
deliver(message)
```

## lib/plugin/vscode-shim/webview-handlers.ts:366

[lib/plugin/vscode-shim/webview-handlers.ts](/Users/bytedance/Project/cognia-next/lib/plugin/vscode-shim/webview-handlers.ts:366)；callee: deliver；level:

```tsx
deliver(pending)
```

## lib/project-environment/resolve-environment.ts:167

[lib/project-environment/resolve-environment.ts](/Users/bytedance/Project/cognia-next/lib/project-environment/resolve-environment.ts:167)；callee: notify；level: "warning"

```tsx
notify({
  source: "system",
  level: "warning",
  title: t(`${titleKey}.title`),
  body,
  // Where the approval card actually is. `/settings` has no copy of it, so
  // the one link on this row was a dead end. The row names the workspace it
  // is about whenever that is not the one on screen.
  href: "/workspace?tab=environments",
  // One row per workspace and kind. A configuration awaiting approval is a
  // standing fact, not an event — a second copy of it is noise.
  dedupeKey: `workspace-config:${input.projectId ?? "-"}:${titleKey}`,
  ...(input.projectId ? { projectId: input.projectId } : {}),
})
```

## lib/provider-diagnostics/refresh.ts:230

[lib/provider-diagnostics/refresh.ts](/Users/bytedance/Project/cognia-next/lib/provider-diagnostics/refresh.ts:230)；callee: notify；level: ；import: @/lib/tauri/notification

```tsx
notify({
  title: "Provider diagnostics",
  body: `${state.providerId}: ${reason.replaceAll("-", " ")}`,
})
```

## lib/pwa/install-state.ts:116

[lib/pwa/install-state.ts](/Users/bytedance/Project/cognia-next/lib/pwa/install-state.ts:116)；callee: notify；level:

```tsx
notify()
```

## lib/pwa/install-state.ts:122

[lib/pwa/install-state.ts](/Users/bytedance/Project/cognia-next/lib/pwa/install-state.ts:122)；callee: notify；level:

```tsx
notify()
```

## lib/pwa/install-state.ts:161

[lib/pwa/install-state.ts](/Users/bytedance/Project/cognia-next/lib/pwa/install-state.ts:161)；callee: notify；level:

```tsx
notify()
```

## lib/scheduler/execution-progress.ts:171

[lib/scheduler/execution-progress.ts](/Users/bytedance/Project/cognia-next/lib/scheduler/execution-progress.ts:171)；callee: notify；level: execution

```tsx
notify(task, execution)
```

## lib/scheduler/notification-integration.ts:115

[lib/scheduler/notification-integration.ts](/Users/bytedance/Project/cognia-next/lib/scheduler/notification-integration.ts:115)；callee: centerNotify；level: centerLevelFor(eventType)；import: @/lib/notifications/runtime

```tsx
centerNotify({
  source: "scheduler",
  level: centerLevelFor(eventType),
  title,
  body,
  channels: coreChannels,
  // Recurring tasks: one updating row per task + event type, however
  // far apart the runs are (the default 45 s window added a row per
  // run). One-shot tasks: per-execution identity.
  dedupeKey: taskEventDedupeKey(task, execution.id, eventType),
  ...(recurring ? { coalesceWindowMs: COALESCE_UNTIL_ARCHIVED } : {}),
  groupKey: `task:${task.id}`,
  // `im-deliver.ts` resolves its destination from a `"conversation"`
  // sourceRef and nothing else, so an IM-bound notification has to carry
  // that instead of the task ref. Emitting two records (one per ref) would
  // double every entry in the feed, so the conversation wins and
  // `groupKey` keeps the task grouping intact either way.
  sourceRef: imConversationKey
    ? { kind: "conversation", id: imConversationKey }
    : { kind: "task", id: task.id },
})
```

## lib/scheduler/notification-integration.ts:279

[lib/scheduler/notification-integration.ts](/Users/bytedance/Project/cognia-next/lib/scheduler/notification-integration.ts:279)；callee: notify；level: ；import: @/lib/tauri/notification

```tsx
notify({ title, body })
```

## lib/server-ops/transport.ts:157

[lib/server-ops/transport.ts](/Users/bytedance/Project/cognia-next/lib/server-ops/transport.ts:157)；callee: notify；level:

```tsx
notify()
```

## lib/server-ops/transport.ts:159

[lib/server-ops/transport.ts](/Users/bytedance/Project/cognia-next/lib/server-ops/transport.ts:159)；callee: notify；level:

```tsx
notify()
```

## lib/sites/notify.ts:268

[lib/sites/notify.ts](/Users/bytedance/Project/cognia-next/lib/sites/notify.ts:268)；callee: notify；level:

```tsx
notify({ ...input, source: "site" })
```

## lib/support-report/channels.ts:124

[lib/support-report/channels.ts](/Users/bytedance/Project/cognia-next/lib/support-report/channels.ts:124)；callee: notify；level:

```tsx
notify()
```

## lib/support-report/channels.ts:128

[lib/support-report/channels.ts](/Users/bytedance/Project/cognia-next/lib/support-report/channels.ts:128)；callee: notify；level:

```tsx
notify()
```

## lib/support-report/channels.ts:162

[lib/support-report/channels.ts](/Users/bytedance/Project/cognia-next/lib/support-report/channels.ts:162)；callee: channel.deliver；level:

```tsx
channel.deliver(report)
```

## lib/support-report/channels.ts:168

[lib/support-report/channels.ts](/Users/bytedance/Project/cognia-next/lib/support-report/channels.ts:168)；callee: notify；level:

```tsx
notify()
```

## lib/tauri/transport-tauri.ts:56

[lib/tauri/transport-tauri.ts](/Users/bytedance/Project/cognia-next/lib/tauri/transport-tauri.ts:56)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("eventChannelLost", {
    source: "tauri",
    message: err instanceof Error ? err.message : String(err),
    meta: { extra: { event } },
  })
)
```

## lib/terminal/recording/player.ts:99

[lib/terminal/recording/player.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/player.ts:99)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/player.ts:112

[lib/terminal/recording/player.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/player.ts:112)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/player.ts:119

[lib/terminal/recording/player.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/player.ts:119)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/player.ts:142

[lib/terminal/recording/player.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/player.ts:142)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/player.ts:153

[lib/terminal/recording/player.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/player.ts:153)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/player.ts:174

[lib/terminal/recording/player.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/player.ts:174)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/player.ts:187

[lib/terminal/recording/player.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/player.ts:187)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/recorder.ts:128

[lib/terminal/recording/recorder.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/recorder.ts:128)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/recorder.ts:135

[lib/terminal/recording/recorder.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/recorder.ts:135)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/recorder.ts:144

[lib/terminal/recording/recorder.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/recorder.ts:144)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/recorder.ts:151

[lib/terminal/recording/recorder.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/recorder.ts:151)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/recorder.ts:175

[lib/terminal/recording/recorder.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/recorder.ts:175)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/recording/recorder.ts:215

[lib/terminal/recording/recorder.ts](/Users/bytedance/Project/cognia-next/lib/terminal/recording/recorder.ts:215)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/session-registry.ts:31

[lib/terminal/session-registry.ts](/Users/bytedance/Project/cognia-next/lib/terminal/session-registry.ts:31)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/session-registry.ts:34

[lib/terminal/session-registry.ts](/Users/bytedance/Project/cognia-next/lib/terminal/session-registry.ts:34)；callee: notify；level:

```tsx
notify()
```

## lib/terminal/session-registry.ts:41

[lib/terminal/session-registry.ts](/Users/bytedance/Project/cognia-next/lib/terminal/session-registry.ts:41)；callee: notify；level:

```tsx
notify()
```

## lib/theme/theme-pack-registry.ts:93

[lib/theme/theme-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/theme/theme-pack-registry.ts:93)；callee: notify；level:

```tsx
notify()
```

## lib/theme/theme-pack-registry.ts:99

[lib/theme/theme-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/theme/theme-pack-registry.ts:99)；callee: notify；level:

```tsx
notify()
```

## lib/theme/theme-pack-registry.ts:111

[lib/theme/theme-pack-registry.ts](/Users/bytedance/Project/cognia-next/lib/theme/theme-pack-registry.ts:111)；callee: notify；level:

```tsx
notify()
```

## lib/theme/theme-registry.ts:82

[lib/theme/theme-registry.ts](/Users/bytedance/Project/cognia-next/lib/theme/theme-registry.ts:82)；callee: notify；level:

```tsx
notify()
```

## lib/theme/theme-registry.ts:88

[lib/theme/theme-registry.ts](/Users/bytedance/Project/cognia-next/lib/theme/theme-registry.ts:88)；callee: notify；level:

```tsx
notify()
```

## lib/theme/theme-registry.ts:100

[lib/theme/theme-registry.ts](/Users/bytedance/Project/cognia-next/lib/theme/theme-registry.ts:100)；callee: notify；level:

```tsx
notify()
```

## lib/theme/theme-registry.ts:130

[lib/theme/theme-registry.ts](/Users/bytedance/Project/cognia-next/lib/theme/theme-registry.ts:130)；callee: notify；level:

```tsx
notify()
```

## lib/usage/cost-budget-runtime.ts:156

[lib/usage/cost-budget-runtime.ts](/Users/bytedance/Project/cognia-next/lib/usage/cost-budget-runtime.ts:156)；callee: notify；level: exceeded \|\| verdict.level === "critical" ? "critical" : "warning"；import: @/lib/notifications/runtime

```tsx
notify({
  source: "system",
  // `critical` bypasses DND and per-source mute — correct for a ceiling that
  // is now blocking work, wrong for an 80% heads-up.
  level: exceeded || verdict.level === "critical" ? "critical" : "warning",
  title: exceeded
    ? `${scopeLabel(verdict)} exhausted`
    : `${scopeLabel(verdict)} at ${formatBudgetRatio(verdict.ratio)}`,
  body: `${money(verdict.usedUsd)} of ${money(verdict.limitUsd)} used.`,
  dedupeKey: `cost-budget:${verdict.scopeKey}:${verdict.level}:${localDayString(now)}`,
  // An exhausted budget blocks work until a human answers, so it belongs on
  // the numeric badge rather than in ambient activity.
  directed: exceeded,
  icon: "wallet",
  // The spend breakdown lives on the Traces channel's dashboard sub-view.
  href: "/logs?channel=traces&tview=dashboard",
})
```

## lib/web/link-preview/preview-store.ts:103

[lib/web/link-preview/preview-store.ts](/Users/bytedance/Project/cognia-next/lib/web/link-preview/preview-store.ts:103)；callee: notify；level:

```tsx
notify(url)
```

## lib/web/link-preview/preview-store.ts:138

[lib/web/link-preview/preview-store.ts](/Users/bytedance/Project/cognia-next/lib/web/link-preview/preview-store.ts:138)；callee: notify；level:

```tsx
notify(url)
```

## lib/web/link-preview/preview-store.ts:164

[lib/web/link-preview/preview-store.ts](/Users/bytedance/Project/cognia-next/lib/web/link-preview/preview-store.ts:164)；callee: notify；level:

```tsx
notify(url)
```

## lib/webdav/remote-newer-notify.ts:35

[lib/webdav/remote-newer-notify.ts](/Users/bytedance/Project/cognia-next/lib/webdav/remote-newer-notify.ts:35)；callee: notify；level: "info"

```tsx
notify({
  source: "system",
  level: "info",
  title: strings.title,
  body: strings.body,
  href: remoteNewerHref(),
  dedupeKey: `webdav-remote-newer:${result.remoteAt ?? "unknown"}`,
  coalesceBackoff: true,
  directed: true,
  icon: "CloudDownload",
})
```

## lib/workflow/apps/alert-service.ts:45

[lib/workflow/apps/alert-service.ts](/Users/bytedance/Project/cognia-next/lib/workflow/apps/alert-service.ts:45)；callee: notify；level: "critical"；import: @/lib/notifications/runtime

```tsx
notify({
  source: "workflow",
  level: "critical",
  title: `Workflow app budget exhausted: ${input.app.slug}`,
  body: "New requests are blocked while in-flight runs continue. Review the deployment budget before resuming traffic.",
  channels: ["center", "toast", "push"],
  dedupeKey: `workflow-app-budget:${input.app.id}:${input.error.code}:${day}`,
  groupKey: `workflow-app:${input.app.id}`,
  sourceRef: { kind: "workflow-app", id: input.app.id },
  directed: true,
  meta: metadata,
})
```

## lib/workflow/editor/store-registry.ts:44

[lib/workflow/editor/store-registry.ts](/Users/bytedance/Project/cognia-next/lib/workflow/editor/store-registry.ts:44)；callee: notify；level:

```tsx
notify()
```

## lib/workflow/editor/store-registry.ts:53

[lib/workflow/editor/store-registry.ts](/Users/bytedance/Project/cognia-next/lib/workflow/editor/store-registry.ts:53)；callee: notify；level:

```tsx
notify()
```

## lib/workflow/nodes/notifications/index.ts:96

[lib/workflow/nodes/notifications/index.ts](/Users/bytedance/Project/cognia-next/lib/workflow/nodes/notifications/index.ts:96)；callee: notify；level: level；import: @/lib/notifications/runtime

```tsx
notify({
  source: "workflow",
  level,
  title,
  body: str(p, "body"),
  href: str(p, "href"),
  icon: str(p, "icon"),
  directed: bool(p, "directed") ?? false,
  groupKey: str(p, "groupKey") ?? ctx.workflowId,
  // A retry of the same step is the same event. Coalescing on the step
  // bumps the existing row's count instead of stacking duplicates.
  dedupeKey: str(p, "dedupeKey") ?? `${ctx.runId}:${ctx.stepId}`,
  ttlMs: int(p, "ttlMs"),
  // ADR-0144 attribution: a notification that cannot name its workspace
  // makes the user click through to find out which one it came from.
  projectId: ctx.projectId,
  sourceRef: { kind: "workflow-run", id: ctx.runId },
})
```

## lib/workflow/runtime/approval-notify.ts:62

[lib/workflow/runtime/approval-notify.ts](/Users/bytedance/Project/cognia-next/lib/workflow/runtime/approval-notify.ts:62)；callee: notify；level:

```tsx
notify(input)
```

## lib/workflow/runtime/human-input-notify.ts:28

[lib/workflow/runtime/human-input-notify.ts](/Users/bytedance/Project/cognia-next/lib/workflow/runtime/human-input-notify.ts:28)；callee: notify；level:

```tsx
notify(input)
```

## packages/agent-opencode/src/client.ts:1883

[packages/agent-opencode/src/client.ts](/Users/bytedance/Project/cognia-next/packages/agent-opencode/src/client.ts:1883)；callee: this.client.tui.showToast；level:

```tsx
this.client.tui.showToast({
  body: { message, variant: variant ?? "info", title },
})
```

## packages/agent/src/connection.ts:179

[packages/agent/src/connection.ts](/Users/bytedance/Project/cognia-next/packages/agent/src/connection.ts:179)；callee: this.transport.peer.notify；level: params

```tsx
this.transport.peer.notify(method, params)
```

## packages/agent/src/connection.ts:289

[packages/agent/src/connection.ts](/Users/bytedance/Project/cognia-next/packages/agent/src/connection.ts:289)；callee: peer.notify；level: {}

```tsx
peer.notify("initialized", {})
```

## packages/logging/src/transports/remote-transport.ts:145

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:145)；callee: this.emitDiagnostic；level: "Remote transport is offline; new batches will be queued for retry."

```tsx
this.emitDiagnostic(
  "logger.remote.offline",
  "Remote transport is offline; new batches will be queued for retry.",
  "warn"
)
```

## packages/logging/src/transports/remote-transport.ts:181

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:181)；callee: this.emitDiagnostic；level: "Failed to initialize remote retry queue."

```tsx
this.emitDiagnostic(
  "logger.remote.queue_init_failed",
  "Failed to initialize remote retry queue.",
  "warn",
  {
    error: String(error),
  }
)
```

## packages/logging/src/transports/remote-transport.ts:400

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:400)；callee: this.emitDiagnostic；level: "Rejected remote logs at the outbound privacy gate."

```tsx
this.emitDiagnostic(
  "logger.remote.privacy_rejected",
  "Rejected remote logs at the outbound privacy gate.",
  "warn",
  { droppedEntries: entryCount }
)
```

## packages/logging/src/transports/remote-transport.ts:416

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:416)；callee: this.emitDiagnostic；level: "Failed to send remote logs after retries."

```tsx
this.emitDiagnostic(
  "logger.remote.send_failed",
  "Failed to send remote logs after retries.",
  "error",
  {
    error: String(error),
    retryCount: this.health.retryCount,
    queueDepth: this.health.queueDepth,
  }
)
```

## packages/logging/src/transports/remote-transport.ts:446

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:446)；callee: this.emitDiagnostic；level: "Dropped queued remote logs due to retry queue capacity limits."

```tsx
this.emitDiagnostic(
  "logger.remote.queue_overflow",
  "Dropped queued remote logs due to retry queue capacity limits.",
  "warn",
  {
    droppedEntries: result.droppedEntries,
    droppedBatches: result.droppedBatches,
    maxQueueEntries: this.options.maxQueueEntries,
    maxQueueBytes: this.options.maxQueueBytes,
  }
)
```

## packages/logging/src/transports/remote-transport.ts:460

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:460)；callee: this.emitDiagnostic；level: "Queued remote logs while offline."

```tsx
this.emitDiagnostic("logger.remote.queued_offline", "Queued remote logs while offline.", "info", {
  queuedEntries: entries.length,
  queueDepth: result.stats.entryCount,
})
```

## packages/logging/src/transports/remote-transport.ts:470

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:470)；callee: this.emitDiagnostic；level: "Queued remote logs after send failures."

```tsx
this.emitDiagnostic(
  "logger.remote.queued_after_failure",
  "Queued remote logs after send failures.",
  "warn",
  {
    queuedEntries: entries.length,
    queueDepth: result.stats.entryCount,
    error: String(error),
  }
)
```

## packages/logging/src/transports/remote-transport.ts:482

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:482)；callee: this.emitDiagnostic；level: "Failed to persist remote retry batch."

```tsx
this.emitDiagnostic(
  "logger.remote.queue_write_failed",
  "Failed to persist remote retry batch.",
  "error",
  {
    reason,
    error: String(queueError),
  }
)
```

## packages/logging/src/transports/remote-transport.ts:524

[packages/logging/src/transports/remote-transport.ts](/Users/bytedance/Project/cognia-next/packages/logging/src/transports/remote-transport.ts:524)；callee: this.emitDiagnostic；level: "Remote transport recovered and drained queued logs."

```tsx
this.emitDiagnostic(
  "logger.remote.recovered",
  "Remote transport recovered and drained queued logs.",
  "info",
  {
    queueDepth: this.health.queueDepth,
  }
)
```

## plugins/browser-tools/src/index.ts:474

[plugins/browser-tools/src/index.ts](/Users/bytedance/Project/cognia-next/plugins/browser-tools/src/index.ts:474)；callee: ui?.showToast；level: "info"

```tsx
ui?.showToast(t("annotate.switchedToLightweight"), "info")
```

## plugins/cognia-anime-effort/src/index.tsx:255

[plugins/cognia-anime-effort/src/index.tsx](/Users/bytedance/Project/cognia-next/plugins/cognia-anime-effort/src/index.tsx:255)；callee: ctx.ui.showToast；level: "success"

```tsx
ctx.ui.showToast(t("panel.success", { level: t(`level.${next}.name`) }), "success")
```

## plugins/cognia-anime-effort/src/index.tsx:258

[plugins/cognia-anime-effort/src/index.tsx](/Users/bytedance/Project/cognia-next/plugins/cognia-anime-effort/src/index.tsx:258)；callee: ctx.ui.showToast；level: "error"

```tsx
ctx.ui.showToast(t("panel.error"), "error")
```

## plugins/cognia-office/src/engine-runtime.ts:41

[plugins/cognia-office/src/engine-runtime.ts](/Users/bytedance/Project/cognia-next/plugins/cognia-office/src/engine-runtime.ts:41)；callee: notify；level:

```tsx
notify()
```

## plugins/cognia-office/src/engine-runtime.ts:72

[plugins/cognia-office/src/engine-runtime.ts](/Users/bytedance/Project/cognia-next/plugins/cognia-office/src/engine-runtime.ts:72)；callee: notify；level:

```tsx
notify()
```

## plugins/e2b-sandbox/src/sandboxes-panel.tsx:87

[plugins/e2b-sandbox/src/sandboxes-panel.tsx](/Users/bytedance/Project/cognia-next/plugins/e2b-sandbox/src/sandboxes-panel.tsx:87)；callee: runtime.ui.showToast；level: "error"

```tsx
runtime.ui.showToast(t("panel.row.releaseFailed", { path }), "error")
```

## plugins/pet-daily-quests/src/index.ts:91

[plugins/pet-daily-quests/src/index.ts](/Users/bytedance/Project/cognia-next/plugins/pet-daily-quests/src/index.ts:91)；callee: ctx.ui.showToast；level: "error"

```tsx
ctx.ui.showToast(
  ctx.i18n.t(error instanceof PetCannotReceiveRewardError ? "claimPetUnavailable" : "claimFailed"),
  "error"
)
```

## plugins/pet-daily-quests/src/quest-store.ts:49

[plugins/pet-daily-quests/src/quest-store.ts](/Users/bytedance/Project/cognia-next/plugins/pet-daily-quests/src/quest-store.ts:49)；callee: notify；level:

```tsx
notify()
```

## plugins/pet-daily-quests/src/quest-store.ts:61

[plugins/pet-daily-quests/src/quest-store.ts](/Users/bytedance/Project/cognia-next/plugins/pet-daily-quests/src/quest-store.ts:61)；callee: notify；level:

```tsx
notify()
```

## plugins/pet-daily-quests/src/quest-store.ts:69

[plugins/pet-daily-quests/src/quest-store.ts](/Users/bytedance/Project/cognia-next/plugins/pet-daily-quests/src/quest-store.ts:69)；callee: notify；level:

```tsx
notify()
```

## plugins/pet-daily-quests/src/quest-store.ts:129

[plugins/pet-daily-quests/src/quest-store.ts](/Users/bytedance/Project/cognia-next/plugins/pet-daily-quests/src/quest-store.ts:129)；callee: notify；level:

```tsx
notify()
```

## plugins/pet-daily-quests/src/quest-store.ts:149

[plugins/pet-daily-quests/src/quest-store.ts](/Users/bytedance/Project/cognia-next/plugins/pet-daily-quests/src/quest-store.ts:149)；callee: notify；level:

```tsx
notify()
```

## plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/approval.ts:125

[plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/approval.ts](/Users/bytedance/Project/cognia-next/plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/approval.ts:125)；callee: ui.notify；level: "info"

```tsx
ui.notify(
  "latexwb: authoring mode on for this session — new equations/labels/citations apply without a prompt; edits to existing protected content still ask.",
  "info"
)
```

## plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/latex-command.ts:166

[plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/latex-command.ts](/Users/bytedance/Project/cognia-next/plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/latex-command.ts:166)；callee: ctx.ui.notify；level: "info"

```tsx
ctx.ui.notify(text, "info")
```

## plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/session-control.ts:91

[plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/session-control.ts](/Users/bytedance/Project/cognia-next/plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/session-control.ts:91)；callee: notify；level:

```tsx
notify?.(
  `latexwb: controlled-session boundary NOT enforceable — ${session.boundaryBrokenReason}. Tool calls will fail closed.`
)
```

## plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/session-control.ts:174

[plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/session-control.ts](/Users/bytedance/Project/cognia-next/plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/session-control.ts:174)；callee: ctx.ui.notify；level: "error"

```tsx
ctx.ui.notify(msg, "error")
```

## plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/tools/patch.ts:163

[plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/tools/patch.ts](/Users/bytedance/Project/cognia-next/plugins/pi-latex-workbench/vendor/packages/adapter-pi/src/tools/patch.ts:163)；callee: ctx.ui.notify；level: type

```tsx
ctx.ui.notify(message, type)
```

## plugins/prompt-templates/src/templates-panel.tsx:71

[plugins/prompt-templates/src/templates-panel.tsx](/Users/bytedance/Project/cognia-next/plugins/prompt-templates/src/templates-panel.tsx:71)；callee: ctx.ui.showToast；level: "success"

```tsx
ctx.ui.showToast(t("toast.inserted", { name: entry.name }), "success")
```

## plugins/prompt-templates/src/templates-panel.tsx:74

[plugins/prompt-templates/src/templates-panel.tsx](/Users/bytedance/Project/cognia-next/plugins/prompt-templates/src/templates-panel.tsx:74)；callee: ctx.ui.showToast；level: "error"

```tsx
ctx.ui.showToast(t("toast.insertFailed", { name: entry.name }), "error")
```

## plugins/prompt-templates/src/templates-panel.tsx:84

[plugins/prompt-templates/src/templates-panel.tsx](/Users/bytedance/Project/cognia-next/plugins/prompt-templates/src/templates-panel.tsx:84)；callee: ctx.ui.showToast；level: "success"

```tsx
ctx.ui.showToast(t("toast.copied", { name: entry.name }), "success")
```

## plugins/prompt-templates/src/templates-panel.tsx:87

[plugins/prompt-templates/src/templates-panel.tsx](/Users/bytedance/Project/cognia-next/plugins/prompt-templates/src/templates-panel.tsx:87)；callee: ctx.ui.showToast；level: "error"

```tsx
ctx.ui.showToast(t("toast.copyFailed", { name: entry.name }), "error")
```

## plugins/screenshot/src/index.ts:527

[plugins/screenshot/src/index.ts](/Users/bytedance/Project/cognia-next/plugins/screenshot/src/index.ts:527)；callee: ctx.ui.showToast；level: "error"

```tsx
ctx.ui.showToast(message, "error")
```

## plugins/screenshot/src/index.ts:534

[plugins/screenshot/src/index.ts](/Users/bytedance/Project/cognia-next/plugins/screenshot/src/index.ts:534)；callee: ctx.ui.showToast；level: "success"

```tsx
ctx.ui.showToast(message, "success")
```

## plugins/skill-recorder/src/index.ts:102

[plugins/skill-recorder/src/index.ts](/Users/bytedance/Project/cognia-next/plugins/skill-recorder/src/index.ts:102)；callee: ctx.ui.showToast；level: "error"

```tsx
ctx.ui.showToast(message, "error")
```

## plugins/strix-security/src/StrixPanel.tsx:117

[plugins/strix-security/src/StrixPanel.tsx](/Users/bytedance/Project/cognia-next/plugins/strix-security/src/StrixPanel.tsx:117)；callee: ui?.showToast；level: "error"

```tsx
ui?.showToast(t(key, { message: messageOf(error) }), "error")
```

## plugins/strix-security/src/StrixPanel.tsx:291

[plugins/strix-security/src/StrixPanel.tsx](/Users/bytedance/Project/cognia-next/plugins/strix-security/src/StrixPanel.tsx:291)；callee: ui.showToast；level: "success"

```tsx
ui.showToast(t("toast.scanDone", { count: r.findingsCount }), "success")
```

## plugins/strix-security/src/StrixPanel.tsx:293

[plugins/strix-security/src/StrixPanel.tsx](/Users/bytedance/Project/cognia-next/plugins/strix-security/src/StrixPanel.tsx:293)；callee: ui.showToast；level: "error"

```tsx
ui.showToast(t("toast.scanFailed"), "error")
```

## plugins/strix-security/src/StrixPanel.tsx:295

[plugins/strix-security/src/StrixPanel.tsx](/Users/bytedance/Project/cognia-next/plugins/strix-security/src/StrixPanel.tsx:295)；callee: ui.showToast；level: "info"

```tsx
ui.showToast(t("toast.scanCancelled"), "info")
```

## plugins/web-clone/src/index.ts:552

[plugins/web-clone/src/index.ts](/Users/bytedance/Project/cognia-next/plugins/web-clone/src/index.ts:552)；callee: ctx.ui.showToast；level: "error"

```tsx
ctx.ui.showToast(message, "error")
```

## plugins/web-clone/src/index.ts:577

[plugins/web-clone/src/index.ts](/Users/bytedance/Project/cognia-next/plugins/web-clone/src/index.ts:577)；callee: ctx.ui.showToast；level: result.ok ? "success" : "error"

```tsx
ctx.ui.showToast(result.message, result.ok ? "success" : "error")
```

## plugins/zhihu-content-pipeline/src/ui/review-modal.tsx:94

[plugins/zhihu-content-pipeline/src/ui/review-modal.tsx](/Users/bytedance/Project/cognia-next/plugins/zhihu-content-pipeline/src/ui/review-modal.tsx:94)；callee: host.ui.showToast；level: "success"

```tsx
host.ui.showToast(t("review.draftCopied"), "success")
```

## services/status-server/probe/src/testing/fake-relay.ts:198

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:198)；callee: socket.deliver；level:

```tsx
socket.deliver({
  kind: "challenge",
  challenge,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 30_000,
})
```

## services/status-server/probe/src/testing/fake-relay.ts:229

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:229)；callee: socket.deliver；level:

```tsx
socket.deliver({ kind: "pong" })
```

## services/status-server/probe/src/testing/fake-relay.ts:234

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:234)；callee: other.socket.deliver；level:

```tsx
other.socket.deliver({
  kind: "peerLeft",
  rendezvousId: session.roomId,
  role: session.role,
  sessionId: session.proof?.sessionId,
})
```

## services/status-server/probe/src/testing/fake-relay.ts:244

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:244)；callee: socket.deliver；level:

```tsx
socket.deliver({ kind: "error", code: "malformed_frame", message: "unknown frame" })
```

## services/status-server/probe/src/testing/fake-relay.ts:258

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:258)；callee: session.socket.deliver；level:

```tsx
session.socket.deliver({
  kind: "error",
  code: "auth_failed",
  message: "subscription signature verification failed",
})
```

## services/status-server/probe/src/testing/fake-relay.ts:272

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:272)；callee: session.socket.deliver；level:

```tsx
session.socket.deliver({ kind: "subscribed", rendezvousId: session.roomId, peers })
```

## services/status-server/probe/src/testing/fake-relay.ts:275

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:275)；callee: other.socket.deliver；level:

```tsx
other.socket.deliver({
  kind: "peerJoined",
  rendezvousId: session.roomId,
  peer: { proof, joinedAtMs: Date.now() },
})
```

## services/status-server/probe/src/testing/fake-relay.ts:286

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:286)；callee: session.socket.deliver；level:

```tsx
session.socket.deliver({ kind: "error", code: "not_subscribed", message: "subscribe first" })
```

## services/status-server/probe/src/testing/fake-relay.ts:299

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:299)；callee: session.socket.deliver；level:

```tsx
session.socket.deliver(refusal)
```

## services/status-server/probe/src/testing/fake-relay.ts:320

[services/status-server/probe/src/testing/fake-relay.ts](/Users/bytedance/Project/cognia-next/services/status-server/probe/src/testing/fake-relay.ts:320)；callee: other.socket.deliver；level:

```tsx
other.socket.deliver(item)
```

## stores/settings/settings-store.ts:503

[stores/settings/settings-store.ts](/Users/bytedance/Project/cognia-next/stores/settings/settings-store.ts:503)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("proxyApplyFailed", {
    source: "settings",
    message: err instanceof Error ? err.message : String(err),
  })
)
```

## stores/settings/settings-store.ts:512

[stores/settings/settings-store.ts](/Users/bytedance/Project/cognia-next/stores/settings/settings-store.ts:512)；callee: dispatchDiagnostic；level: ；import: @/lib/diagnostics/bus

```tsx
dispatchDiagnostic(
  createDiagnostic("sidecarUnreachable", {
    source: "settings",
    message: err instanceof Error ? err.message : String(err),
  })
)
```
