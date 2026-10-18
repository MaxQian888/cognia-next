# MiniMax M Plan 订阅插件

[English](./README.md)

可独立安装、更新、停用的桌面插件。独立目录对应独立安装包；复用宿主的账户面板、凭据库、模型注册和额度查询，不另建网络客户端、不读取密钥。图标由仓库已有的 Lobe 厂商品牌 SVG 渲染为 PNG。

## 构建与安装

仓库根目录安装依赖后执行：

```sh
pnpm exec node plugins/minimax-subscription/build.mjs
pnpm exec jest --runInBand --coverage=false --runTestsByPath plugins/minimax-subscription/src/index.test.ts plugins/minimax-subscription/build.test.mjs
```

在 Cognia 桌面插件页选择本地 ZIP 安装，使用 `plugins/minimax-subscription/dist/cognia-minimax-subscription-0.1.0.zip`，然后启用插件。需要支持订阅计费元数据和声明式额度请求的宿主版本；仅凭应用版本号 0.1.0 不能判断能力。浏览器与移动端禁止激活，因为凭据保存在桌面凭据库。

## 账户与 AI 提供商联动

1. 打开 设置 → 订阅 → 账户中心 → 添加账户。
2. 选择与账号匹配的国内 / 国际入口以及 OpenAI Chat / Anthropic Messages 协议；区域和协议使用独立账户命名空间。
3. 从 M Plan 套餐详情获取并填写 **订阅 Key（Subscription Key）**，不要填写普通按量 API Key。
4. 保存并明确激活账户；在 AI 提供商页面管理该插件的模型、测试连接，也可从关联入口返回账户管理。
5. 在聊天或支持“使用 Cognia 模型”的外部 Agent 中选择该订阅提供商。

所有入口都声明 `billingMode: "subscription"`、厂商品牌和关联提供商 ID。关联仅用于导航；不会复制按量 API Key、账户选择或开关状态。订阅账户缺失、过期或额度耗尽时，不应自动切换到按量 API。停用插件会移除可用入口与模型；已保存账户仍在宿主凭据库，供主动删除或重装同 ID 插件后使用。

当前产品名为 M Plan，旧版 Token Plan 权益由厂商继续管理。订阅 Key 消耗套餐额度与支持范围内的积分包，积分包可能承接超额用量；这与普通 API Key 扣除按量账户余额不同。两种 Key 共用推理地址，因此不能只根据 URL 判断计费来源。

## 端点与模型

| 入口 ID                         | 协议      | Base URL                           |
| ------------------------------- | --------- | ---------------------------------- |
| `minimax-m-plan`                | openai    | `https://api.minimax.cn/v1`        |
| `minimax-m-plan-anthropic`      | anthropic | `https://api.minimax.cn/anthropic` |
| `minimax-m-plan-intl`           | openai    | `https://api.minimax.io/v1`        |
| `minimax-m-plan-anthropic-intl` | anthropic | `https://api.minimax.io/anthropic` |

默认模型为 MiniMax-M3.1-Flash-Preview，客户端上下文 524288 tokens，最大输出 128000 tokens，依据官方第三方工具配置。声明文本/图像输入、工具调用、思考与流式输出；不通过 Cognia 聊天适配器承诺原始视频/音频支持。

静态模型是已公布模型的回退元数据，不代表账户权益。套餐文档未确认模型列表/详情端点，因此本插件不声明模型发现 API、不虚构 URL、不伪装其他客户端。实际权益与允许的使用范围以厂商规定为准。

## 额度与错误

宿主向国内 www.minimax.cn 或国际 www.minimax.io 发送 GET /v1/token_plan/remains，使用 Bearer 认证，额度 origin 与推理 origin 明确分开。读取 model_remains 中 general 条目的 5 小时/周剩余百分比，并反转为已用百分比；重置时间为毫秒。旧版 *_usage_count 含义存在歧义，不据其推算。缺少字段时保持未知，可前往官方控制台核对。

Key 不进入清单、源码、插件设置、ZIP 或返回的额度快照。请求由宿主使用选定账户发起。401/403 可能对应 Key、区域、权益或订阅过期问题；连接与额度错误会保留显示。本次未进行真实账户调用。

## 资料与验证

资料核对日期：2026-10-18。官方资料链接、额度数据依据与英文说明一致：

- [International tool configuration](https://platform.minimax.io/docs/m-plan/other-tools)
- [China tool configuration](https://platform.minimax.cn/docs/m-plan/other-tools)
- [International FAQ: keys, billing and quota endpoint](https://platform.minimax.io/docs/m-plan/faq)
- [China FAQ](https://platform.minimax.cn/docs/m-plan/faq)
- [Official CLI quota schema](https://github.com/MiniMax-AI/cli/blob/main/src/types/api.ts)
- [Official CLI legacy count ambiguity](https://github.com/MiniMax-AI/cli/blob/main/src/utils/quota.ts)

测试覆盖安装器校验、清单与模块一致性、计费隔离元数据、区域/协议地址、额度提取及可重复构建、独立 ZIP 执行。测试不代表厂商真实账户已经验收。

订阅插件的推理和额度请求始终使用清单声明的地址；旧账户中保存的转发预设和自定义地址会被忽略，账户记录本身不会被修改。
