---
title: 插件签名
description: 生成发布者密钥对、为插件签名，并配置官方可信密钥。
---

# 插件签名

Cognia 在确认安装前会校验插件的 **Ed25519 分离签名**。签名强制由
**设置 → 插件 → 策略** 面板控制：

- **强制签名**（`signatureRequired`，默认**开启**）——未签名插件在安装时被拒绝。
- **仅信任的发布者**（`trustedPublishersOnly`，默认关闭）——仅接受来自官方密钥或你信任的发布者的有效签名；未知签名者被拒绝。

## 官方密钥在构建期注入

官方发布者公钥**不**提交进仓库，而是在构建期从环境变量
`NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY` 读取
（`lib/plugin/security/signature.ts → OFFICIAL_PLUGIN_PUBLIC_KEY`）。当该变量未设置时：

- `isOfficialPublisherKeyConfigured()` 返回 `false`，
- **不**植入任何官方发布者（因此空键签名永远无法伪装成官方锚点），
- `trustedPublishersOnly` 在配置真实密钥前会拒绝一切。

要发布已签名的第一方插件，在 `pnpm build` 前设置该变量为你的 base64 Ed25519 公钥：

```bash
NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY="<base64-公钥>" pnpm build
```

**私钥**务必不要进仓库、不要进 CI 日志——只有公钥会被内嵌。

## 生成密钥对

密钥生成器运行在 Tauri 后端（`plugin_generate_keypair`），渲染层通过以下方式调用：

```ts
import { getPluginSignatureVerifier } from "@/lib/plugin/security/signature"

const { publicKey, privateKey } = await getPluginSignatureVerifier().generateKeyPair()
// 把 `privateKey` 存入密码管理器 / CI 密钥库。
// `publicKey` 用作 NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY（也是其他用户加入可信发布者列表的 `author.publicKey`）。
```

## 为插件签名

```ts
const signature = await getPluginSignatureVerifier().signPlugin(pluginPath, privateKey, {
  algorithm: "ed25519",
})
```

这会在插件包旁写入分离签名。实际密码学由 Rust 侧
（`plugin_create_signature` / `plugin_verify_detached_signature`）完成；往返测试见
`src-tauri/src/plugin_api/signature.rs`。

## 添加社区发布者

用户无需重新构建即可信任额外发布者：校验器以公钥为键持久化用户添加的发布者
（`addTrustedPublisher`）。开启**仅信任的发布者**后，只接受官方密钥加上这些用户添加的密钥。
