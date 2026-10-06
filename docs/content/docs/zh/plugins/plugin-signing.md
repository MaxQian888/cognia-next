---
title: 插件签名
description: 生成发布者密钥对、为插件签名，并配置官方可信密钥。
---

# 插件签名

Cognia 在用户确认安装前校验插件的 **Ed25519 分离签名**。是否强制校验签名，由**设置 → 插件 → 策略**面板控制：

- **强制签名**（`signatureRequired`，默认**开启**）——未签名插件在安装时被拒绝。
- **仅信任的发布者**（`trustedPublishersOnly`，默认关闭）——仅接受来自官方密钥或你信任的发布者的有效签名；未知签名者被拒绝。

## 官方密钥在构建期注入

官方发布者公钥**不**提交进仓库，而是在构建期从环境变量 `NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY` 读取（`lib/plugin/security/signature.ts → OFFICIAL_PLUGIN_PUBLIC_KEY`）。当该变量未设置时：

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
// 两个密钥均为 hex 编码。公钥字节需转为 base64，才能用于
// NEXT_PUBLIC_COGNIA_PLUGIN_PUBKEY 或 author.publicKey。
```

## 为绑定元数据的制品签名

```ts
const signature = await getPluginSignatureVerifier().signPlugin(artifactPath, privateKey, {
  pluginId: "my-plugin",
  version: "1.0.0",
  algorithm: "ed25519",
})
```

传入制品文件路径和 hex 私钥。必填的插件 ID 和版本必须与制品元数据一致。`plugin_create_signature` 对 `pluginId + ":" + version + ":" + artifactBytes` 的 SHA-256 摘要签名，对应校验命令为 `plugin_verify_signature`。返回对象包含插件 ID、版本、hex 签名、hex 公钥和 `Date` 类型的 `signedAt`，不会写入签名文件。仅支持 Ed25519；RSA 和 `expiresIn` 选项会在调用后端前被拒绝。

## 为可安装的插件包签名

安装器使用对插件包原始字节的独立签名。通过 CLI 传入包含 base64 私钥的文件：

```bash
cognia plugin sign ./my-plugin.zip --key /secure/publisher-private.b64
```

该命令写入 `my-plugin.zip.sig`，其中的 base64 分离签名由 `plugin_verify_detached_signature` 校验。`signPlugin` 返回的元数据绑定签名不能替代此文件。两种格式的 Rust 往返测试位于 `crates/cognia-plugin-runtime/src/signature.rs`。

## 添加社区发布者

用户无需重新构建即可信任额外发布者：校验器以公钥为键持久化用户添加的发布者（`addTrustedPublisher`）。开启**仅信任的发布者**后，只接受官方密钥加上这些用户添加的密钥。
