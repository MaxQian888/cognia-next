# 智谱 / Z.ai Coding Plan 插件

[English](./README.md)

可独立安装、更新、停用的桌面插件。独立目录对应独立安装包；复用宿主的账户面板、凭据库、模型注册和额度查询，不另建网络客户端、不读取密钥。图标由仓库已有的 Lobe 厂商品牌 SVG 渲染为 PNG。

## 构建与安装

仓库根目录安装依赖后执行：

```sh
pnpm exec node plugins/zhipu-subscription/build.mjs
pnpm exec jest --runInBand --coverage=false --runTestsByPath plugins/zhipu-subscription/src/index.test.ts plugins/zhipu-subscription/build.test.mjs
```

在 Cognia 桌面插件页选择本地 ZIP 安装，使用 `plugins/zhipu-subscription/dist/cognia-zhipu-subscription-0.1.0.zip`，然后启用插件。需要支持订阅计费元数据和声明式额度请求的宿主版本；仅凭应用版本号 0.1.0 不能判断能力。浏览器与移动端禁止激活，因为凭据保存在桌面凭据库。

## 账户与 AI 提供商联动

1. 打开 设置 → 订阅 → 账户中心 → 添加账户。
2. 选择与账号匹配的国内 / 国际入口以及 OpenAI Chat / Anthropic Messages 协议；区域和协议使用独立账户命名空间。
3. 填写对应 BigModel / Z.ai 账户的 API Key，账户需要有效 GLM Coding Plan；订阅入口固定使用套餐专用端点。
4. 保存并明确激活账户；在 AI 提供商页面管理该插件的模型、测试连接，也可从关联入口返回账户管理。
5. 在聊天或支持“使用 Cognia 模型”的外部 Agent 中选择该订阅提供商。

所有入口都声明 `billingMode: "subscription"`、厂商品牌和关联提供商 ID。关联仅用于导航；不会复制按量 API Key、账户选择或开关状态。订阅账户缺失、过期或额度耗尽时，不应自动切换到按量 API。停用插件会移除可用入口与模型；已保存账户仍在宿主凭据库，供主动删除或重装同 ID 插件后使用。

国内 BigModel 与国际 Z.ai 账户独立。标准按量 API 使用 /api/paas/v4；插件的 OpenAI 入口使用 /api/coding/paas/v4，Anthropic 使用 /api/anthropic。不要为绕过额度失败而将订阅地址改为标准按量地址；确需按量调用时应主动选择独立标准提供商。

## 端点与模型

| 入口 ID                     | 协议      | Base URL                                      |
| --------------------------- | --------- | --------------------------------------------- |
| `glm-coding`                | openai    | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `glm-coding-anthropic`      | anthropic | `https://open.bigmodel.cn/api/anthropic`      |
| `glm-coding-intl`           | openai    | `https://api.z.ai/api/coding/paas/v4`         |
| `glm-coding-anthropic-intl` | anthropic | `https://api.z.ai/api/anthropic`              |

模型为 glm-5.3（文本）与 glm-5.3-flash（文本/图像），上下文 1M、输出上限 128K，支持工具调用、思考和流式输出。官方明确 FlashX 尚未纳入套餐，因此不加入。Cognia 聊天适配器不承诺原始视频/音频支持。

静态模型是已公布模型的回退元数据，不代表账户权益。套餐文档未确认模型列表/详情端点，因此本插件不声明模型发现 API、不虚构 URL、不伪装其他客户端。实际权益与允许的使用范围以厂商规定为准。

## 额度与错误

宿主向推理 host 的 origin 请求 GET /api/monitor/usage/quota/limit，使用官方插件采用的原始 Authorization Key（无 Bearer 前缀）。复用宿主已有提取规则：data.limits 中 unit 3 为 5 小时、unit 6 为每周，percentage 为已用比例、nextResetTime 为 Unix 秒。返回形状不符时缺失窗口保持未知，可前往官方控制台核对。

Key 不进入清单、源码、插件设置、ZIP 或返回的额度快照。请求由宿主使用选定账户发起。401/403 可能对应 Key、区域、权益或订阅过期问题；连接与额度错误会保留显示。本次未进行真实账户调用。

## 资料与验证

资料核对日期：2026-10-18。官方资料链接、额度数据依据与英文说明一致：

- [Z.ai Coding Plan overview](https://docs.z.ai/devpack/overview)
- [BigModel Coding Plan FAQ and endpoints](https://docs.bigmodel.cn/cn/coding-plan/faq)
- [Z.ai FAQ and endpoints](https://docs.z.ai/devpack/faq)
- [GLM-5.3 model reference](https://docs.z.ai/guides/llm/glm-5.3)
- [GLM-5.3-Flash model reference](https://docs.z.ai/guides/vlm/glm-5.3-flash)
- [Official usage-query plugin](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)

测试覆盖安装器校验、清单与模块一致性、计费隔离元数据、区域/协议地址、额度提取及可重复构建、独立 ZIP 执行。测试不代表厂商真实账户已经验收。

订阅插件的推理和额度请求始终使用清单声明的地址；旧账户中保存的转发预设和自定义地址会被忽略，账户记录本身不会被修改。
