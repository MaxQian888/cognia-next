# Kimi Code 订阅插件

[English](./README.md)

这是 Cognia `subscription-provider` 能力的完整可安装示例。启用后，Kimi Code 会出现在现有的
订阅添加面板和模型选择器中。插件声明 OpenAI Chat 和 Anthropic Messages 两种接入、模型元数据及模型列表接口；
账号面板、凭据保管和请求均由宿主处理。

## 使用条件

- 使用本仓库中已实现 `subscription-provider` 能力的 Cognia 桌面版。旧版本不支持此能力；
  仅凭应用的 `0.1.0` 版本号不能确认是否支持。
- 拥有可使用 API Key 的 Kimi Code 订阅，并在
  [Kimi Code 控制台](https://www.kimi.com/code/console)创建密钥。
- 构建前，在仓库根目录运行 `pnpm install` 安装依赖。

本示例接入 **Kimi Code 订阅 API**。Moonshot 按量计费平台的密钥和地址属于另一套服务。
账号流程依赖桌面凭据库，因此插件明确禁止在浏览器和移动端启用。

## 构建与安装

在仓库根目录执行：

```sh
pnpm exec node plugins/kimi-subscription/build.mjs
```

产物为 `plugins/kimi-subscription/dist/cognia-kimi-subscription-0.2.0.zip`。
压缩包只包含 `plugin.json`、编译后的 `dist/index.js` 和中英文说明。
安装后不依赖源码仓库、SDK 包或 Node.js。构建复用仓库已有的 esbuild 和 JSZip。

1. 打开 Cognia 桌面版的插件面板，选择从本地 `.wasm` / `.zip` 安装。
2. 选择生成的 ZIP，检查清单并安装，必要时启用插件。
3. 打开「设置 → 订阅 → 账号中心」，选择 **Kimi Code**（OpenAI Chat）
   或 **Kimi Code (Anthropic)**（Messages），按实际使用的协议添加账号。
4. 在通用 API Key 面板中填写账号名称和控制台生成的密钥。
5. 可在面板中刷新模型列表、查看模型信息。列表请求失败不会清空内置声明，也不会阻止手动保存账号。
6. 激活已保存的账号，在聊天模型选择器中选择对应的 Kimi 服务和 `kimi-for-coding`。
   按 Kimi 的使用条款将订阅用于编程任务。

其他读取订阅注册表的添加入口、预设账号流程也会显示该服务。完整 provider ID 为
`cognia-kimi-subscription:kimi-code`（保持原有 ID）；Anthropic 为
`cognia-kimi-subscription:kimi-code-anthropic`。两种协议分别管理账号，更新相同插件 ID 会保留原有账号。

## 模型与套餐

以下内容于 **2026-09-11** 按[官方模型文档](https://www.kimi.com/code/docs/en/kimi-code/models.html)核对：

| 模型 ID                     | 套餐要求            | 选择建议                         |
| --------------------------- | ------------------- | -------------------------------- |
| `kimi-for-coding`           | 所有 Kimi Code 会员 | 默认选项；底层模型由服务端维护。 |
| `k3-256k`                   | Moderato 及以上     | 固定 256K 上下文的 K3。          |
| `k3`                        | Moderato 及以上     | 上下文上限取决于套餐。           |
| `kimi-for-coding-highspeed` | Allegretto 及以上   | 更高速度，消耗更多额度。         |

模型列表表示官方可选项，不代表当前账号已获得所有模型权限。建议先使用 `kimi-for-coding`。
`kimi-for-coding` 对应的底层模型可能自动升级；当前官方文档描述为 K2.8 Preview。
关闭 thinking 时，K3/K2.8 请求会转到关闭思考的 K2.8。
本示例不新增模型专用推理控制，也不保证所有客户端支持每项模型参数。

OpenAI Chat Completions 基础地址为 `https://api.kimi.com/coding/v1`，请求路径和凭据由宿主添加。
Anthropic 根地址为 `https://api.kimi.com/coding/`，宿主只追加一次 `/v1`，再请求 `/messages`。
OpenAI 入口明确声明 `apiFlavor: "chat"`；宿主也支持 Responses，但本示例不声称 Kimi 支持 Responses。
插件不覆盖请求头，也不伪装官方客户端身份。参见[官方订阅指南](https://www.kimi.com/en/help/kimi-code/membership-guide)。

## 模型列表与详情接口

两个入口均声明 `GET https://api.kimi.com/coding/v1/models`，宿主按所选协议添加认证信息，
解析名称、上下文和能力字段，以账号接口返回的明确值覆盖静态声明，并保留未知字段的回退值。
Kimi 的模型详情从列表推导（`retrieve: false`），不虚构 `/models/{id}`；其他明确支持详情接口的
插件可声明 `retrieve: true`，调用标准模型详情接口。

静态声明包含视觉、推理、流式及上下文。部分 Kimi 模型支持视频，但 Cognia 当前两个协议的
附件流程只接入图片和文档，因此示例明确声明 `supportsVideo: false`。实时接口返回的是上游
模型能力，不会自动开放新的附件类型。K3 按最低可用套餐采用保守的 256K 回退；
刷新后可使用账号实际的上下文上限。总上下文、最大输入和最大输出分别保存。Kimi 官方 CLI 文档中的模型响应没有公开最大输出
上限，因此本例保留未知；服务端提供实际字段后，宿主会解析并传递给模型选择、Agent 请求、
路由和上下文压缩。未知价格同样不填假值。
这些限制用于 Cognia 自行调度的请求和子代理。下述托管外部任务也会通过运行时专用配置和网关约束
获得模型元数据；运行时未开放的 SDK 原生控制项仍无法由 Cognia 配置。
供应商设置中的「刷新模型」也请求同一订阅接口并更新模型信息。模型列出不等于推理请求已验证。

## 在外部 Agent 中使用订阅

1. 按上述步骤安装插件并添加订阅账号。
2. 在设置中的 Agent 页面或聊天中的 Agent 管理面板，添加/编辑支持的本地 Codex、OpenCode、
   Pi、Claude ACP 或 Qwen Code ACP Agent，开启「使用 Cognia 模型」。
3. 选择本插件的服务、`kimi-for-coding` 和订阅账号，然后新建任务。

外部 Agent 保留自己的工具和对话循环。Cognia 提供任务专用配置和临时网关凭据，Kimi 密钥留在
Cognia 内。Codex 的 Responses 请求由网关转换为插件声明的上游协议；使用 Codex 时不要将
Kimi 的 `apiFlavor` 改成 `responses`。

已知的上下文、输入和输出上限会传入运行时，网关同时执行模型和 token 约束。恢复任务时保留
原模型、订阅账号和 Cognia 所属账号；更换模型或账号需要新建任务。停止会撤销临时凭据，删除
会话会清理保留的任务状态。文件系统和网络隔离遵循所选沙箱；连接现有远程服务或不支持的运行时
会明确失败，不会注入无法访问的回环地址。

已通过本地模拟服务验证真实 Codex 经 Rust 网关的工具调用，以及 Pi 沙箱内的工具调用和续聊。
这些验证不代表真实 Kimi 会员权限或所有 Agent/模型组合的鉴权推理均已验证。

## 绑定 Team 队友或 SDK 子代理

为外部 Team 队友选择运行时后，可在队友编辑器开启「使用 Cognia 模型」。绑定保存在该队友
配置中，每次调度使用独立网关任务。引导和停止定位到该任务自己的会话；恢复时保持原模型和账号。

另一个拥有 `agent:dispatch` 权限的插件可以使用以下 SDK 类型：

```ts
import {
  defineSubagent,
  type ExternalAgentCogniaModelBinding,
  type PluginContext,
} from "@cognia/plugin-sdk"

export async function reviewWithKimi(ctx: PluginContext, prompt: string, accountId: string) {
  const cogniaModel: ExternalAgentCogniaModelBinding = {
    providerId: "cognia-kimi-subscription:kimi-code",
    modelId: "kimi-for-coding",
    accountId,
  }
  const reviewer = defineSubagent({
    id: "kimi-reviewer",
    name: "Kimi reviewer",
    description: "Reviews code through Cognia's Kimi subscription.",
    prompt: "Review the requested code and report actionable findings.",
    externalPresetId: "codex-app-server",
    cogniaModel,
  })
  return ctx.agent.dispatchSubagent(reviewer, prompt)
}
```

`accountId` 使用 Cognia 中已保存的订阅账号 ID，不能填写 API Key。省略账号时，在新任务启动
时解析当前账号，恢复时沿用已冻结的实际账号。第三个参数传入 `{ cogniaModel: anotherBinding }`
可覆盖定义；传入 `{ cogniaModel: null }` 明确使用 Agent 的原生模型配置。仅设置原生 `model`
字符串不会选择 Cognia provider/账号。本订阅示例本身不申请 Agent 调度权限，也不会自动启动 Agent。

## 账号生命周期与排查

- 密钥由 Cognia 已有凭据库管理，不应写入清单、插件配置、源码或 ZIP。插件不申请读取密钥权限。
- 停用或卸载插件会移除服务和模型注册；已保存账号保留在宿主凭据库，供用户明确删除，或在重新
  安装相同插件 ID 后复用。
- 用量入口打开官方控制台。本示例没有虚构自动余额或额度接口。
- `401` 可能是模型套餐权限不足，也可能是密钥无效。先尝试 `kimi-for-coding`，检查控制台中的
  会员资格与密钥，并确认使用的是 Kimi Code 密钥，而非 Moonshot 平台密钥。
- 遇到额度耗尽或限流，查看控制台和[官方错误说明](https://www.kimi.com/code/docs/en/kimi-code/error-reference.html)。
- 服务未出现时检查插件是否启用、是否处于桌面版；模型存在但请求失败时，检查账号是否激活、
  套餐是否允许所选模型。

## 复制为其他订阅插件

复制本目录时排除 `dist/`。修改 `plugin.json` 中的插件 ID、名称及相应的
`subscriptionProviders` 声明：服务 ID、协议、基础地址、模型 ID 或完整模型对象、模型接口支持和官方链接。只保留服务实际支持的协议；
OpenAI Responses 服务使用 `apiFlavor: "responses"`。第一个模型是默认值。
入口模块可以原样保留；宿主负责注册、各个添加面板、预设、凭据和卸载清理。
同步更新说明和测试期望，然后重新构建。升级已有插件时应保留插件和服务 ID，否则会产生不同的账号命名空间。

此方式适用于标准 OpenAI Chat Completions 或 Anthropic Messages API Key 服务。
OAuth、自定义签名和自动用量适配需要额外的宿主能力。

## 验证

在仓库根目录执行，不收集覆盖率：

```sh
pnpm exec node --test plugins/kimi-subscription/build.test.mjs
pnpm exec jest --runInBand --coverage=false --roots plugins/kimi-subscription --runTestsByPath plugins/kimi-subscription/src/index.test.ts
```

测试检查真实安装清单校验、宿主注册与移除、模型选择、清单一致性、ZIP 内容和编译后入口执行。
测试不会使用真实密钥调用 Kimi，也不能证明某个账号拥有指定模型的使用权限。
