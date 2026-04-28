# React Quick Starter

一个现代化的全栈启动模板，结合了用于 Web 应用的 **Next.js 16** 和 **React 19**，以及用于跨平台桌面应用的 **Tauri 2.9**。使用 TypeScript、Tailwind CSS v4 和 shadcn/ui 组件构建。

[English Documentation](./README.md)

## 特性

- ⚡️ **Next.js 16** 配合 App Router 和 React 19
- 🖥️ **Tauri 2.9** 用于原生桌面应用（Windows、macOS、Linux）
- 🎨 **Tailwind CSS v4** 支持 CSS 变量和暗色模式
- 🧩 **shadcn/ui** 组件库，基于 Radix UI 原语
- 📦 **Zustand** 轻量级状态管理
- 🔤 **Geist 字体** 通过 next/font 优化
- 🎯 **TypeScript** 提供类型安全
- 🎭 **Lucide Icons** 精美的图标库
- 📚 **Fumadocs** 文档站点，作为 pnpm workspace 子包
- 📱 双重部署：从同一代码库部署 Web 应用或桌面应用

## 前置要求

在开始之前，请确保已安装以下内容：

### Web 开发所需

- **Node.js** 20.x 或更高版本（[下载](https://nodejs.org/)）
- **pnpm** 8.x 或更高版本（推荐）或 npm/yarn

  ```bash
  npm install -g pnpm
  ```

### 桌面开发所需（额外要求）

- **Rust** 1.70 或更高版本（[安装](https://www.rust-lang.org/tools/install)）

  ```bash
  # 验证安装
  rustc --version
  cargo --version
  ```

- **系统依赖**（因操作系统而异）：
  - **Windows**：Microsoft Visual Studio C++ 生成工具
  - **macOS**：Xcode 命令行工具
  - **Linux**：参见 [Tauri 前置要求](https://tauri.app/v1/guides/getting-started/prerequisites)

## 安装

1. **克隆仓库**

   ```bash
   git clone <your-repo-url>
   cd react-quick-starter
   ```

2. **安装依赖**

   ```bash
   pnpm install
   # 或
   npm install
   # 或
   yarn install
   ```

3. **验证安装**

   ```bash
   # 检查 Next.js 是否就绪
   pnpm dev

   # 检查 Tauri 是否就绪（可选，用于桌面开发）
   pnpm tauri info
   ```

## 开发

### Web 应用开发

#### 启动开发服务器

```bash
pnpm dev
# 或
npm run dev
```

这将在 [http://localhost:3000](http://localhost:3000) 启动 Next.js 开发服务器。当您编辑文件时，页面会自动重新加载。

#### 关键开发文件

- `app/page.tsx` - 主着陆页
- `app/layout.tsx` - 根布局及全局配置
- `app/globals.css` - 全局样式和 Tailwind 配置
- `components/ui/` - 可复用的 UI 组件（shadcn/ui）
- `lib/utils.ts` - 工具函数

### 桌面应用开发

#### 启动 Tauri 开发模式

```bash
pnpm tauri dev
```

此命令将：

1. 启动 Next.js 开发服务器
2. 启动 Tauri 桌面应用
3. 为前端和 Rust 代码启用热重载

#### Tauri 开发文件

- `src-tauri/src/main.rs` - Rust 应用主入口点
- `src-tauri/src/lib.rs` - Rust 库代码
- `src-tauri/tauri.conf.json` - Tauri 配置
- `src-tauri/Cargo.toml` - Rust 依赖

### 从 JavaScript 调用 Rust

该模板内置了一个类型安全的 IPC 桥接示例。使用模式如下：

1. **在 `src-tauri/src/commands.rs` 中添加 Rust 命令**：

   ```rust
   #[tauri::command]
   pub fn my_command(arg: &str) -> Result<String, AppError> {
     Ok(format!("got {arg}"))
   }
   ```

2. **在 `src-tauri/src/lib.rs` 中注册命令**：

   ```rust
   .invoke_handler(tauri::generate_handler![commands::greet, commands::my_command])
   ```

3. **在 `lib/tauri.ts` 中添加类型化封装函数**：

   ```ts
   export async function myCommand(arg: string): Promise<string> {
     return invoke<string>("my_command", { arg })
   }
   ```

`lib/tauri.ts` 是唯一调用 `invoke()` 的地方——业务代码从中导入具名函数，而非直接使用 `invoke`。使用 `isTauri()` 来保护依赖桌面运行时的代码路径。

## 可用脚本

### 前端脚本

| 命令                 | 描述                                              |
| -------------------- | ------------------------------------------------- |
| `pnpm dev`           | 在端口 3000 启动 Next.js 开发服务器               |
| `pnpm build`         | 构建 Next.js 应用用于生产（输出到 `out/` 目录）   |
| `pnpm start`         | 启动 Next.js 生产服务器（执行 `pnpm build` 之后） |
| `pnpm lint`          | 运行 ESLint 检查代码质量                          |
| `pnpm lint:fix`      | 自动修复 ESLint 问题                              |
| `pnpm format`        | 用 Prettier 格式化所有文件                        |
| `pnpm format:check`  | 检查格式而不写入                                  |
| `pnpm typecheck`     | 运行 TypeScript 类型检查（不生成产物）            |
| `pnpm test`          | 运行 Jest 单元测试                                |
| `pnpm test:watch`    | 监听模式运行 Jest                                 |
| `pnpm test:coverage` | 运行 Jest 并生成覆盖率报告                        |

### Tauri（桌面）脚本

| 命令                | 描述                            |
| ------------------- | ------------------------------- |
| `pnpm tauri dev`    | 启动 Tauri 开发模式，支持热重载 |
| `pnpm tauri build`  | 构建生产环境的桌面应用          |
| `pnpm tauri info`   | 显示 Tauri 环境信息             |
| `pnpm tauri icon`   | 从源图像生成应用图标            |
| `pnpm tauri --help` | 显示所有可用的 Tauri 命令       |

### 文档站点脚本（Fumadocs — 端口 3001）

| 命令              | 描述                                     |
| ----------------- | ---------------------------------------- |
| `pnpm docs:dev`   | 在端口 3001 启动 Fumadocs 开发服务器     |
| `pnpm docs:build` | 构建文档生产版本（输出到 `docs/.next/`） |
| `pnpm docs:start` | 在端口 3001 启动文档生产服务器           |

### 添加 UI 组件（shadcn/ui）

```bash
# 添加新组件（例如 Card）
pnpm dlx shadcn@latest add card

# 添加多个组件
pnpm dlx shadcn@latest add button card dialog
```

## 项目结构

```
react-quick-starter/
├── app/                      # Next.js App Router（主应用）
│   ├── layout.tsx           # 根布局，包含字体和元数据
│   ├── page.tsx             # 主着陆页
│   ├── globals.css          # 全局样式和 Tailwind 配置
│   └── favicon.ico          # 应用图标
├── components/              # React 组件
│   └── ui/                  # shadcn/ui 组件（Button 等）
├── lib/                     # 工具函数
│   └── utils.ts            # 辅助函数（cn 等）
├── public/                  # 静态资源（图片、SVG）
├── src-tauri/              # Tauri 桌面应用
│   ├── src/
│   │   ├── main.rs         # Rust 主入口点
│   │   └── lib.rs          # Rust 库代码
│   ├── icons/              # 桌面应用图标
│   ├── tauri.conf.json     # Tauri 配置
│   └── Cargo.toml          # Rust 依赖
├── docs/                    # Fumadocs 文档站点（workspace 子包）
│   ├── app/                # Next.js App Router（文档）
│   │   ├── layout.tsx      # 根布局，含 RootProvider
│   │   ├── page.tsx        # 重定向到 /docs
│   │   ├── global.css      # Tailwind v4 + Fumadocs 主题
│   │   ├── docs/           # 文档路由
│   │   │   ├── layout.tsx  # 含侧边栏的 DocsLayout
│   │   │   └── [[...slug]]/ # 动态 MDX 页面
│   │   └── api/search/     # Orama 搜索 API 路由
│   ├── lib/source.ts       # Fumadocs 内容加载器
│   ├── content/docs/       # MDX 内容文件
│   ├── source.config.ts    # 内容集合配置
│   ├── next.config.ts      # Next.js 配置（无静态导出）
│   └── package.json        # 文档包依赖
├── pnpm-workspace.yaml      # pnpm monorepo 配置
├── components.json          # shadcn/ui 配置
├── next.config.ts          # Next.js 配置（主应用）
├── tsconfig.json           # TypeScript 配置
├── eslint.config.mjs       # ESLint 配置
└── package.json            # 根依赖和脚本
```

## 配置

### 环境变量

将 `.env.example` 复制为 `.env.local` 开始使用：

```bash
cp .env.example .env.local
```

然后编辑 `.env.local` 填入实际值。`lib/env.ts` 模块会在首次访问时校验必需变量。

**重要提示**：

- 只有以 `NEXT_PUBLIC_` 为前缀的变量会暴露给浏览器
- 切勿将 `.env.local` 提交到版本控制
- 使用 `.env.example` 记录所需的变量

### Tauri 配置

编辑 `src-tauri/tauri.conf.json` 以自定义您的桌面应用：

```json
{
  "productName": "react-quick-starter", // 应用名称
  "version": "0.1.0", // 应用版本
  "identifier": "com.reactquickstarter.desktop", // 唯一应用标识符
  "build": {
    "frontendDist": "../out", // Next.js 构建输出
    "devUrl": "http://localhost:3000" // 开发服务器 URL
  },
  "app": {
    "windows": [
      {
        "title": "react-quick-starter", // 窗口标题
        "width": 800, // 默认宽度
        "height": 600, // 默认高度
        "resizable": true, // 允许调整大小
        "fullscreen": false // 全屏启动
      }
    ]
  }
}
```

### 路径别名

在 `components.json` 和 `tsconfig.json` 中配置：

```typescript
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
```

可用别名：

- `@/components` → `components/`
- `@/lib` → `lib/`
- `@/ui` → `components/ui/`
- `@/hooks` → `hooks/`
- `@/utils` → `lib/utils.ts`

### Tailwind CSS 配置

项目使用 Tailwind CSS v4，具有以下特性：

- 使用 CSS 变量进行主题化（在 `app/globals.css` 中定义）
- 通过 `class` 策略支持暗色模式
- 使用 CSS 变量的自定义调色板
- shadcn/ui 样式系统

## 生产构建

### 构建 Web 应用

```bash
# 构建静态导出
pnpm build

# 输出目录：out/
# 将 out/ 目录部署到任何静态托管服务
```

构建会在 `out/` 目录中创建一个静态导出，已针对生产环境进行优化。

### 构建桌面应用

```bash
# 为当前平台构建
pnpm tauri build

# 输出位置：
# - Windows: src-tauri/target/release/bundle/msi/
# - macOS: src-tauri/target/release/bundle/dmg/
# - Linux: src-tauri/target/release/bundle/appimage/
```

构建选项：

```bash
# 为特定目标构建
pnpm tauri build --target x86_64-pc-windows-msvc

# 使用调试符号构建
pnpm tauri build --debug

# 不打包构建
pnpm tauri build --bundles none
```

## 部署

### 文档站点部署

文档站点（`docs/`）是一个完整的 Next.js 服务端应用，与主应用独立部署。

```bash
# 构建文档
pnpm docs:build

# 输出：docs/.next/
# 部署到任意 Node.js 托管平台：Vercel、Netlify、Railway 等
```

在 **Vercel** 上，导入项目时将根目录设置为 `docs/`。

### Web 部署

#### Vercel（推荐）

1. 将代码推送到 GitHub/GitLab/Bitbucket
2. 在 [Vercel](https://vercel.com/new) 上导入项目
3. Vercel 会自动检测 Next.js 并部署

#### Netlify

```bash
# 构建命令
pnpm build

# 发布目录
out
```

#### 静态托管（Nginx、Apache 等）

1. 构建项目：`pnpm build`
2. 将 `out/` 目录上传到您的服务器
3. 配置服务器以提供静态文件

### 桌面部署

#### Windows

- 分发 `src-tauri/target/release/bundle/msi/` 中的 `.msi` 安装程序
- 用户运行安装程序以安装应用

#### macOS

- 分发 `src-tauri/target/release/bundle/dmg/` 中的 `.dmg` 文件
- 用户将应用拖到应用程序文件夹
- **注意**：对于 App Store 之外的分发，您需要使用 Apple 开发者证书对应用进行签名

#### Linux

- 分发 `src-tauri/target/release/bundle/appimage/` 中的 `.AppImage`
- 用户使其可执行并运行：`chmod +x app.AppImage && ./app.AppImage`
- 替代格式：`.deb`（Debian/Ubuntu）、`.rpm`（Fedora/RHEL）

#### 代码签名（生产环境推荐）

- **Windows**：使用代码签名证书
- **macOS**：需要 Apple 开发者账户和证书
- **Linux**：可选，但建议用于分发

详细说明请参见 [Tauri 分发指南](https://tauri.app/v1/guides/distribution/)。

## 开发工作流

### 典型开发周期

1. **启动开发服务器**

   ```bash
   pnpm dev  # 用于 Web 开发
   # 或
   pnpm tauri dev  # 用于桌面开发
   ```

2. **进行更改**
   - 编辑 `app/`、`components/` 或 `lib/` 中的文件
   - 更改会在浏览器/桌面应用中自动重新加载

3. **添加新组件**

   ```bash
   pnpm dlx shadcn@latest add [component-name]
   ```

4. **检查代码**

   ```bash
   pnpm lint
   ```

5. **构建和测试**

   ```bash
   pnpm build  # 测试 Web 构建
   pnpm tauri build  # 测试桌面构建
   ```

### 最佳实践

- **代码风格**：遵循 ESLint 规则（`pnpm lint`）
- **提交规范**：通过 `commit-msg` 钩子（commitlint）强制 Conventional Commits。clone 后运行一次 `pnpm install` —— `prepare` 脚本会自动安装钩子。
- **组件**：保持组件小而可复用
- **状态**：使用 Zustand 管理全局状态，使用 React hooks 管理局部状态
- **样式**：使用 Tailwind 工具类，尽可能避免自定义 CSS
- **类型**：利用 TypeScript 实现类型安全

## 故障排除

### 常见问题

**端口 3000 已被占用**

```bash
# 终止使用端口 3000 的进程
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# macOS/Linux
lsof -ti:3000 | xargs kill -9
```

**Tauri 构建失败**

```bash
# 检查 Tauri 环境
pnpm tauri info

# 更新 Rust
rustup update

# 清理构建缓存
cd src-tauri
cargo clean
```

**模块未找到错误**

```bash
# 清除 Next.js 缓存
rm -rf .next

# 重新安装所有 workspace 依赖
rm -rf node_modules docs/node_modules pnpm-lock.yaml
pnpm install
```

**文档中出现 `Cannot find module 'collections/server'`**

该模块由 fumadocs-mdx 自动生成。运行一次文档开发服务器即可生成：

```bash
pnpm docs:dev
```

## 了解更多

### Next.js 资源

- [Next.js 文档](https://nextjs.org/docs) - 了解 Next.js 功能和 API
- [学习 Next.js](https://nextjs.org/learn) - 交互式 Next.js 教程
- [Next.js GitHub](https://github.com/vercel/next.js) - Next.js 仓库

### Tauri 资源

- [Tauri 文档](https://tauri.app/) - Tauri 官方文档
- [Tauri API 参考](https://tauri.app/v1/api/js/) - JavaScript API 参考
- [Tauri GitHub](https://github.com/tauri-apps/tauri) - Tauri 仓库

### UI 和样式

- [shadcn/ui](https://ui.shadcn.com/) - 组件库文档
- [Tailwind CSS](https://tailwindcss.com/docs) - Tailwind CSS 文档
- [Radix UI](https://www.radix-ui.com/) - Radix UI 原语

### 状态管理

- [Zustand](https://zustand-demo.pmnd.rs/) - Zustand 文档

### 文档

- [Fumadocs](https://fumadocs.dev/) - Fumadocs 文档框架

## 贡献

欢迎贡献！请遵循以下步骤：

1. Fork 仓库
2. 创建功能分支（`git checkout -b feature/amazing-feature`）
3. 提交更改（`git commit -m 'feat: add amazing feature'`）
4. 推送到分支（`git push origin feature/amazing-feature`）
5. 打开 Pull Request

## 许可证

本项目是开源的，采用 [MIT 许可证](LICENSE)。

## 支持

如果您遇到任何问题或有疑问：

- 查看[故障排除](#故障排除)部分
- 查阅 [Next.js 文档](https://nextjs.org/docs)
- 查阅 [Tauri 文档](https://tauri.app/)
- 在 GitHub 上提出 issue
