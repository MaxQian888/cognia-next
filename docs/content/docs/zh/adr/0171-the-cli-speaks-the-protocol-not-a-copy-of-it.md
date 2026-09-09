---
title: "0171：CLI 说的是协议本身，不是协议的副本"
description: "cognia-agent 通过冻结协议契约生成的命令索引触达宿主命令面，只走调度器真正认可的两种授权模式，并在本地就拒掉宿主一定会拒的调用。"
---

# ADR 0171：CLI 说的是协议本身，不是协议的副本

**状态：** 已接受
**日期：** 2026-09-06
**修订：** ADR-0013（命令清单）、ADR-0078（CLI ↔ App 桥）
**被修订：** ADR-0175（CLI 索引的 group 与 action 改由声明的 resource 与 verb 给出）
**相关：** ADR-0059（无头大脑）、ADR-0143（设备控制台）、ADR-0153（确认由宿主取得）

## 背景

`cognia-agent` 有 23 条手写命令，其中只有两条真的会调用宿主：`lark` 自带一套
`fetch` 加轮询，`provider` 背后是 CLI 唯一一层真正的传输抽象。

与此同时宿主发布的是一个被完整描述过的命令面。生成的 Companion 规范里有 656 条
具体的 `/internal/_rpc/{name}` 操作与 527 条具体的 `/api/_rpc/{name}` 操作，而且
只要有任何一条 RPC 会退化成通用请求形状，`pnpm companion-api:gen` 就会失败。每条
命令的字段、类型、枚举、风险、审批与幂等要求都是机器可读且有漂移门禁的。

于是「从终端触达一条命令」等于「再写一条命令」，而这条命令早就被契约描述过了。
ADR-0013 当年选择手写白名单而非代码生成，并写明「超过约 150 条时重新评估」。今天
这个面是 1318 条描述符、656 条可远程调度的命令。

## 决定了设计走向的那条约束

`src-tauri/src/companion_api/remote_execution.rs` 里的 `authorize_transport` 与
`authorize_approval` 只认可两种授权模式，没有第三种：

```rust
let allowed = if transport == Internal { service_principal }
              else { !service_principal
                     && target ∈ {Execution, HostAdmin}
                     && descriptor.transports.contains(transport) };
```

```rust
if principal.scope == "service" && transport == Internal { return Ok(()); }
```

| 模式 | 路由 | 覆盖 | 能力校验 | 审批校验 |
| --- | --- | --- | --- | --- |
| service + Internal | `POST /internal/_rpc/{name}` | 全部 656 条 | 绕过 | 绕过 |
| device + Http | `POST /api/_rpc/{name}` | 527 条 | 按设备授权 | 管理租约或签名策略 |

回环 service 主体被刻意设计为大脑面的策略权威，device 主体被刻意设计为不是。

## 决定

1. **CLI 的命令索引从协议契约生成。**
   `scripts/build/gen-cli-api-index.mjs` 把 `protocol/companion-commands.json`
   与两份 OpenAPI 规范合并成 `cli/src/api/generated/command-index.ts`，
   `pnpm cli:api:check` 在漂移时失败，与 `companion-api:check` 对它自己的来源
   一样。给宿主加一条命令就等于给 CLI 加一条命令。

2. **一个索引，两层界面。** `api call/list/groups/describe/schema/request`
   是地板，保证覆盖率；派生的 `<资源> <动作>` 命令是线上命令名的投影，
   `plugin list` 就是 `api call plugin_list`。23 条手写命令无条件保留自己的名字，
   有四个协议分组与之冲突，并由测试钉死这份名单，使新增的宿主命令不可能悄悄改变
   一条熟悉命令的含义。

3. **只有两条线，CLI 绝不假装有第三条。** 当选中的线不承载某条命令时，本地直接
   拒绝，因为 `authorize_transport` 无论如何都会拒。在设备线上，缺租约的
   `interactive` 命令与缺策略的 `signed-policy` 命令会带着补救办法被拒，而不是发
   出去换一个 428。

4. **契约已经说不的，就别上线。** 每份 companion 请求 schema 都是
   `additionalProperties: false` 且运行期强制，所以未知字段必然是 422。未知字段、
   缺失必填字段、别名互斥组与越界枚举全部先对索引校验；宿主对 1090 条命令要求的
   UUID 幂等键由 CLI 铸造，而不是留给调用方。

5. **宿主是被保存的记录，不是环境变量。** `~/.cognia/hosts.json`（0600）保存端点、
   线路、凭据与 TLS SPKI 指纹。层级按键合并：命令行、环境、项目文件、用户文件。
   `host show` 会打印每个值最终来自哪里。

6. **CLI 桥继续做凭据中介，不做调度。** ADR-0078 给桥的是 18 条路由与同用户回环
   信任模型。在那里加一条通用 `/api/dev/_rpc/{name}` 就必须以 service 主体走
   Internal 传输，会把 dev-token 桥从 8 条低风险只读的白名单一举抬到全部 656 条
   命令且绕过全部审批，偏偏就在那台有人可以回答审批的宿主上。桌面端改为与它自己
   的 Companion API 配对触达，与手机走的是同一条流程。

## 后果

- CLI 的覆盖率就是宿主的覆盖率，靠门禁维持而不是靠评审。
- 失败会给出下一步动作。每次拒绝都带 `Fix` 与 `Inspect` 行，因为这里读失败输出的
  首要读者是 agent。
- 登记过的 CLI 是设备控制台里可见、可授权、可暂停、可吊销的一台设备，它不会获得
  设备线本来就不会给手机的任何权限。
- 索引是编译进产物的，约 270 KB，因此 `api list`、`describe` 与 `--help` 都能离线
  作答，格式错误的调用根本不会碰到 socket。
- ADR-0013 的「手写白名单、不做代码生成」仍然管着宿主暴露什么。本 ADR 只管客户端
  如何消费已暴露的部分，白名单仍是安全边界。
- 桌面 CLI 桥不因这项工作获得任何东西。若将来「在本机免输配对码」真的值得一条路由，
  它必须像 `/api/dev/acp/ticket` 那样中介一份凭据，绝不调度命令。

## 考虑过的替代方案

- **按子系统手写资源命令。** 否决：不可能完整，且每条新宿主命令都变成一次 CLI 改动。
- **在 CLI 桥上加通用调度路由。** 依据上面的授权分析否决。那是一次披着便利外衣的
  提权。
- **运行时读取 OpenAPI 规范。** 否决：每次调用要解析 5.5 MB YAML，而 CLI 以单文件
  打包发布。
- **一切交给宿主校验。** 否决：契约本来就在客户端，一次点名字段的本地拒绝胜过一个
  什么都没说的 422。
