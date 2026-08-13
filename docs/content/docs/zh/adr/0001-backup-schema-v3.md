---
title: ADR-0001 — 备份格式 v3
description: 将 Cognia 的完整备份格式移植到 cognia-next，提供加密、完整性校验、历史记录与按域分项导出。
---

# 备份格式 v3

| 状态     | 已接受                                                                   |
| -------- | ------------------------------------------------------------------------ |
| 日期     | 2026-04-30                                                               |
| 取代     | `lib/data/export-schema.ts` 中最初发布的 v1 `ExportEnvelope`。           |

## 背景

cognia-next 最初只有一个极简的 v1 导出信封：一个扁平的 JSON 文件，包含
用户的 settings、characters、skills、presets，以及（可选的）sessions。
它能在同一周内的两个安装之间搬运数据，但对以下需求毫无帮助：

- 一个可放进备份工具、又不会泄露 API key 的磁盘文件。
- 可验证的完整性——「文件是不是写到一半被截断了？」。
- 用设备存储的密钥（一键）或口令（跨设备可移植）加密。
- 在 Tauri 上的提醒 + 定时写入，让用户不会忘记。
- 按域分项导出（只导我的 skills、只导我的 MCP servers）。
- 从其他助手导入（ChatGPT、Claude.ai、Gemini Takeout）。

Cognia（原产品）已在一个 `BackupPackageV3` 格式里解决了所有这些问题。
cognia-next 沿用同样的形态，裁剪到我们自己的领域。

## 决策

### 文件格式

```
BackupPackageV3                        # plaintext
├── version: "3.0"
├── manifest                           # who / when / where + integrity
│   ├── version: "3.0"
│   ├── schemaVersion: 3
│   ├── traceId
│   ├── exportedAt (ISO 8601)
│   ├── appVersion
│   ├── backend: "web-dexie" | "tauri-dexie"
│   └── integrity: { algorithm: "SHA-256", checksum }
└── payload                            # every Dexie-backed user table
    ├── settings
    ├── characters / skills / skillResources / teams
    ├── promptPresets / mcpServers
    ├── sessions / messages / sessionState
    └── trustedWorkspaces / ttsProviderKeys

EncryptedEnvelopeV1                    # AES-GCM wrap of a serialized v3 plaintext
├── version: "enc-v1"
├── algorithm: "AES-GCM"
├── kdf: PBKDF2-SHA256-600000-Salt16
├── iv: random 12 bytes
├── ciphertext: base64
├── manifest: same as above (minus `integrity`)
└── checksum: SHA-256 of plaintext

DomainExportFile                       # single-table slice
├── version: "cognia-domain-1.0"
├── domain: skills | mcpServers | promptPresets | characters | teams | settingsTheme
├── exportedAt (ISO 8601)
├── appVersion
└── payload (BackupPayloadV3 subset)
```

迁移边界位于 `lib/data/migrate.ts`。它接受 v1 文件，把扁平字段提升进一个
合成的 v3 manifest+payload，因此既有的用户文件可以永远继续工作。

### 加密模式

导出对话框提供三种模式：

1. **自动密钥**（默认）——用设备存储的密钥加密（Tauri：
   `@tauri-apps/plugin-store`，web：`localStorage`）。一键完成，在其他
   设备上不可读，除非用户也导出了该密钥。
2. **自定义口令**——PBKDF2-SHA256，600 000 次迭代 + AES-GCM。
3. **明文**——文件可直接读取，因此必须经过单独的风险警告确认，并且绝不携带
   retrieval DEK。

加密备份会携带 canonical retrieval ciphertext，并使用同一个 backup key 或
passphrase 分别封装每个已配置的 retrieval-profile DEK。词法索引 segment 属于
可重建派生数据，恢复后重新生成。

导入器会检测加密形态，先静默尝试自动密钥，只有在失败时才回退到口令提示。

### 增量式流式 v4 codec（2026-08-06）

大型数据库不能先聚合成单个 `BackupPayloadV3` 对象再写出。因此，新增的
v4 codec 使用逐行的 `header → chunk* → footer` 记录：

- `buildBackupStream` 通过主键游标读取 catalog 绑定的 portable 数据；
  消费者读取完一条记录后，对应的 IndexedDB page 即可释放。
- 每个 chunk 独立计算 SHA-256；固定大小的 SHA-256 hash chain 绑定
  header、chunk 顺序和必需的 footer，无需在内存中保存所有 chunk hash。
- 加密流使用 PBKDF2-SHA256 和逐记录 AES-GCM。8 字节随机 nonce 前缀与
  32 位记录序号组成唯一的 12 字节 IV；format、trace id 和 sequence
  作为 AAD 一并认证。
- decoder 在暴露已验证 chunk 前会检查记录大小、顺序、checksum、footer、
  KDF 参数和 nonce 边界。

这是新增格式 seam，不会替换旧格式。v1/v3 导入继续保持可读；现有 UI、
scheduler 和 WebDAV 在流式 sink 与可恢复 restore adapter 完成前仍写出
v3。没有配套恢复链路时，不得把 v4 codec 接入这些生产 writer。

### 备份历史 + 提醒 + 自动定时

新增的 Dexie 表 `backupHistory`（v10）记录每一次成功或失败的导出。历史
最多保留最新的 50 行。settings 单例新增：

- `backupReminderDays`（默认 7）——软提醒频率。
- `backupReminderDismissedAt`——为提醒横幅做去抖。
- `backupAutoSchedule`——`{ enabled, intervalDays, dirPath, retainCount }`，
  用于仅 Tauri 的定时写入循环。

调度器运行在挂载于应用根部的 `BackupSchedulerProvider` 中。它每 30 分钟
（以及挂载时一次）检查 `shouldRunScheduledBackup` 是否返回 true；若是，
则向 `dirPath` 写入一个自动密钥加密的文件，并清理超出 `retainCount` 的
旧自动备份。

### 外部格式导入

`lib/data/importers/{chatgpt,claude,gemini}-import.ts` 各自把一种第三方
导出形态解析成我们的 `ChatSession` + `StoredMessage` 行。
`lib/data/import-registry.ts` 基于一次廉价的结构嗅探进行分派。

对话框是统一的——单一的「从其他助手导入」入口会接收用户拖入的任意格式。

## 后果

- **v1 用户文件继续工作**，得益于 `migrateEnvelope`。用户无需知道我们
  改过了格式版本。
- **明文格式在 SHA-256 之前按规范键排序**（`canonicalStringify`），因此
  manifest 的完整性校验在不同 JS 引擎和表迭代顺序下都保持稳定。
- **加密是可选项。** 明文仍是默认，因为多数用户备份到的是他们已经信任
  的文件夹（Drive、Dropbox）。
- **定时只在 Tauri 上可用。** 浏览器无法静默写入文件夹；web 用户得到的
  是提醒横幅。
- **`jszip` 是懒加载的**，位于 `lib/export/batch/batch-export.ts` 内。在
  用户打开批量导出对话框之前，它不会进入主包。

## 文件地图

| 路径                                                    | 用途                                                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `lib/data/types.ts`                                     | 类型契约、错误类、`EXPORT_SCHEMA_VERSION`                                                |
| `lib/data/crypto.ts`                                    | `sha256Hex`、`encryptBackupPackage`、`decryptBackupPackage`                              |
| `lib/data/backup-key.ts`                                | 设备存储的自动密钥 + 轮换                                                                |
| `lib/data/migrate.ts`                                   | v1 → v3 边界；完整性校验                                                                 |
| `lib/data/build-package.ts`                             | 读取 Dexie 表 → `BackupPackageV3`                                                        |
| `lib/data/build-stream.ts`                              | 以有界 v4 page 读取 portable Dexie 数据                                                  |
| `lib/data/stream-format.ts`                             | 编解码带认证的 v4 NDJSON 记录                                                            |
| `lib/data/apply-package.ts`                             | 写回 `BackupPackageV3`，尊重内置项                                                       |
| `lib/data/scheduler.ts`                                 | 纯辅助函数：`shouldRunScheduledBackup`、`shouldShowReminder`、`pruneScheduledBackups`    |
| `lib/data/import-registry.ts`                           | 外部格式分派器                                                                           |
| `lib/data/importers/{chatgpt,claude,gemini}-import.ts`  | 各平台解析器                                                                             |
| `lib/data/domain/index.ts`                              | 按域导出/导入 + 注册表                                                                   |
| `lib/db/backup-history.ts`                              | 历史表的 Dexie CRUD                                                                      |
| `lib/export/text/rich-markdown.ts`                      | Markdown / JSON / 纯文本格式化器                                                         |
| `lib/export/html/{beautiful,animated,syntax-themes}.ts` | HTML 导出                                                                                |
| `lib/export/batch/batch-export.ts`                      | 多会话 ZIP                                                                               |
| `lib/export/single/index.ts`                            | 单会话分派器                                                                             |
| `hooks/data/*`                                          | 各流程的 React 侧接线                                                                    |
| `components/data/*`                                     | 对话框 + 共享部件（口令输入、加密选项、历史表）                                          |
| `components/settings/data/*`                            | Tab 外壳 + 四个 tab                                                                      |
| `components/providers/backup-scheduler-provider.tsx`    | 调度器运行器                                                                             |

## 验证

- 所有 ≥90% 测试覆盖率阈值通过 `pnpm test:coverage` 强制。
- `lib/data/**`、`lib/export/**`、`hooks/data/**` 共 136 个测试覆盖整个
  往返：build → encrypt → migrate → decrypt → apply。
- 手工冒烟测试：
  1. 以每种加密模式导出；再导入产出的文件。
  2. 拖入一个 ChatGPT / Claude / Gemini 导出；确认对话落地。
  3. 按域行导出 → 重置 → 再导入；确认完整恢复。
  4. 在 Tauri 中启用定时备份；推进时钟；确认一个
     `cognia-backup-*.enc.cbk` 落入所选文件夹。
