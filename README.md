# React Quick Starter

A modern, full-stack starter template combining **Next.js 16** with **React 19** for web applications and **Tauri 2.9** for cross-platform desktop applications. Built with TypeScript, Tailwind CSS v4, and shadcn/ui components.

[中文文档](./README_zh.md)

## Features

- ⚡️ **Next.js 16** with App Router and React 19
- 🖥️ **Tauri 2.9** for native desktop applications (Windows, macOS, Linux)
- 🎨 **Tailwind CSS v4** with CSS variables and dark mode support
- 🧩 **shadcn/ui** component library with Radix UI primitives
- 📦 **Zustand** for lightweight state management
- 🔤 **Geist Font** optimized with next/font
- 🎯 **TypeScript** for type safety
- 🎭 **Lucide Icons** for beautiful iconography
- 📚 **Fumadocs** documentation site as a pnpm workspace subpackage
- 📱 Dual deployment: Web app OR Desktop app from the same codebase

## Prerequisites

Before you begin, ensure you have the following installed:

### For Web Development

- **Node.js** 20.x or later ([Download](https://nodejs.org/))
- **pnpm** 8.x or later (recommended) or npm/yarn

  ```bash
  npm install -g pnpm
  ```

### For Desktop Development (Additional Requirements)

- **Rust** 1.70 or later ([Install](https://www.rust-lang.org/tools/install))

  ```bash
  # Verify installation
  rustc --version
  cargo --version
  ```

- **System Dependencies** (varies by OS):
  - **Windows**: Microsoft Visual Studio C++ Build Tools
  - **macOS**: Xcode Command Line Tools
  - **Linux**: See [Tauri Prerequisites](https://tauri.app/v1/guides/getting-started/prerequisites)

## Installation

1. **Clone the repository**

   ```bash
   git clone <your-repo-url>
   cd react-quick-starter
   ```

2. **Install dependencies**

   ```bash
   pnpm install
   # or
   npm install
   # or
   yarn install
   ```

3. **Verify installation**

   ```bash
   # Check if Next.js is ready
   pnpm dev

   # Check if Tauri is ready (optional, for desktop development)
   pnpm tauri info
   ```

## Development

### Web Application Development

#### Start Development Server

```bash
pnpm dev
# or
npm run dev
```

This starts the Next.js development server at [http://localhost:3000](http://localhost:3000). The page auto-reloads when you edit files.

#### Key Development Files

- `app/page.tsx` - Main landing page
- `app/layout.tsx` - Root layout with global configuration
- `app/globals.css` - Global styles and Tailwind configuration
- `components/ui/` - Reusable UI components (shadcn/ui)
- `lib/utils.ts` - Utility functions

### Desktop Application Development

#### Start Tauri Development Mode

```bash
pnpm tauri dev
```

This command:

1. Starts the Next.js development server
2. Launches the Tauri desktop application
3. Enables hot-reload for both frontend and Rust code

#### Tauri Development Files

- `src-tauri/src/main.rs` - Main Rust application entry point
- `src-tauri/src/lib.rs` - Rust library code
- `src-tauri/tauri.conf.json` - Tauri configuration
- `src-tauri/Cargo.toml` - Rust dependencies

### Calling Rust from JavaScript

The template ships a typed IPC bridge demo. Pattern:

1. **Add a Rust command** in `src-tauri/src/commands.rs`:

   ```rust
   #[tauri::command]
   pub fn my_command(arg: &str) -> Result<String, AppError> {
     Ok(format!("got {arg}"))
   }
   ```

2. **Register it** in `src-tauri/src/lib.rs`:

   ```rust
   .invoke_handler(tauri::generate_handler![commands::greet, commands::my_command])
   ```

3. **Add a typed wrapper** in `lib/tauri.ts`:

   ```ts
   export async function myCommand(arg: string): Promise<string> {
     return invoke<string>("my_command", { arg })
   }
   ```

`lib/tauri.ts` is the single point that calls `invoke()` — business code imports named functions from it. Use `isTauri()` to gate any code path that depends on the desktop runtime.

## Available Scripts

### Frontend Scripts

| Command              | Description                                                    |
| -------------------- | -------------------------------------------------------------- |
| `pnpm dev`           | Start Next.js development server on port 3000                  |
| `pnpm build`         | Build Next.js app for production (outputs to `out/` directory) |
| `pnpm start`         | Start Next.js production server (after `pnpm build`)           |
| `pnpm lint`          | Run ESLint to check code quality                               |
| `pnpm lint:fix`      | Auto-fix ESLint issues                                         |
| `pnpm format`        | Format all files with Prettier                                 |
| `pnpm format:check`  | Check formatting without writing                               |
| `pnpm typecheck`     | Run TypeScript type-check (no emit)                            |
| `pnpm test`          | Run Jest unit tests                                            |
| `pnpm test:watch`    | Run Jest in watch mode                                         |
| `pnpm test:coverage` | Run Jest with coverage report                                  |

### Tauri (Desktop) Scripts

| Command             | Description                                  |
| ------------------- | -------------------------------------------- |
| `pnpm tauri dev`    | Start Tauri development mode with hot-reload |
| `pnpm tauri build`  | Build production desktop application         |
| `pnpm tauri info`   | Display Tauri environment information        |
| `pnpm tauri icon`   | Generate app icons from source image         |
| `pnpm tauri --help` | Show all available Tauri commands            |

### Docs Site Scripts (Fumadocs — port 3001)

| Command           | Description                               |
| ----------------- | ----------------------------------------- |
| `pnpm docs:dev`   | Start Fumadocs dev server on port 3001    |
| `pnpm docs:build` | Build docs for production (`docs/.next/`) |
| `pnpm docs:start` | Start docs production server on port 3001 |

### Adding UI Components (shadcn/ui)

```bash
# Add a new component (e.g., Card)
pnpm dlx shadcn@latest add card

# Add multiple components
pnpm dlx shadcn@latest add button card dialog
```

## Project Structure

```
react-quick-starter/
├── app/                      # Next.js App Router (main app)
│   ├── layout.tsx           # Root layout with fonts and metadata
│   ├── page.tsx             # Main landing page
│   ├── globals.css          # Global styles and Tailwind config
│   └── favicon.ico          # App favicon
├── components/              # React components
│   └── ui/                  # shadcn/ui components (Button, etc.)
├── lib/                     # Utility functions
│   └── utils.ts            # Helper functions (cn, etc.)
├── public/                  # Static assets (images, SVGs)
├── src-tauri/              # Tauri desktop application
│   ├── src/
│   │   ├── main.rs         # Rust main entry point
│   │   └── lib.rs          # Rust library code
│   ├── icons/              # Desktop app icons
│   ├── tauri.conf.json     # Tauri configuration
│   └── Cargo.toml          # Rust dependencies
├── docs/                    # Fumadocs documentation site (workspace package)
│   ├── app/                # Next.js App Router for docs
│   │   ├── layout.tsx      # Root layout with RootProvider
│   │   ├── page.tsx        # Redirect to /docs
│   │   ├── global.css      # Tailwind v4 + Fumadocs theme
│   │   ├── docs/           # Docs routes
│   │   │   ├── layout.tsx  # DocsLayout with sidebar
│   │   │   └── [[...slug]]/ # Dynamic MDX page
│   │   └── api/search/     # Orama search API route
│   ├── lib/source.ts       # Fumadocs content loader
│   ├── content/docs/       # MDX content files
│   ├── source.config.ts    # Content collection config
│   ├── next.config.ts      # Next.js config (no static export)
│   └── package.json        # Docs package dependencies
├── pnpm-workspace.yaml      # pnpm monorepo config
├── components.json          # shadcn/ui configuration
├── next.config.ts          # Next.js configuration (main app)
├── tsconfig.json           # TypeScript configuration
├── eslint.config.mjs       # ESLint configuration
└── package.json            # Root dependencies and scripts
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env.local` to start:

```bash
cp .env.example .env.local
```

Then edit `.env.local` to fill in your values. The `lib/env.ts` module validates required vars at first access.

**Important**:

- Only variables prefixed with `NEXT_PUBLIC_` are exposed to the browser
- Never commit `.env.local` to version control
- Use `.env.example` to document required variables

### Tauri Configuration

Edit `src-tauri/tauri.conf.json` to customize your desktop app:

```json
{
  "productName": "react-quick-starter", // App name
  "version": "0.1.0", // App version
  "identifier": "com.reactquickstarter.desktop", // Unique app identifier
  "build": {
    "frontendDist": "../out", // Next.js build output
    "devUrl": "http://localhost:3000" // Dev server URL
  },
  "app": {
    "windows": [
      {
        "title": "react-quick-starter", // Window title
        "width": 800, // Default width
        "height": 600, // Default height
        "resizable": true, // Allow resizing
        "fullscreen": false // Start fullscreen
      }
    ]
  }
}
```

### Path Aliases

Configured in `components.json` and `tsconfig.json`:

```typescript
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
```

Available aliases:

- `@/components` → `components/`
- `@/lib` → `lib/`
- `@/ui` → `components/ui/`
- `@/hooks` → `hooks/`
- `@/utils` → `lib/utils.ts`

### Tailwind CSS Configuration

The project uses Tailwind CSS v4 with:

- CSS variables for theming (defined in `app/globals.css`)
- Dark mode support via `class` strategy
- Custom color palette using CSS variables
- shadcn/ui styling system

## Building for Production

### Build Web Application

```bash
# Build static export
pnpm build

# Output directory: out/
# Deploy the out/ directory to any static hosting service
```

The build creates a static export in the `out/` directory, optimized for production.

### Build Desktop Application

```bash
# Build for current platform
pnpm tauri build

# Output locations:
# - Windows: src-tauri/target/release/bundle/msi/
# - macOS: src-tauri/target/release/bundle/dmg/
# - Linux: src-tauri/target/release/bundle/appimage/
```

Build options:

```bash
# Build for specific target
pnpm tauri build --target x86_64-pc-windows-msvc

# Build with debug symbols
pnpm tauri build --debug

# Build without bundling
pnpm tauri build --bundles none
```

## Deployment

### Docs Site Deployment

The docs site (`docs/`) is a full Next.js server application deployed independently from the main app.

```bash
# Build docs
pnpm docs:build

# Output: docs/.next/
# Deploy to any Node.js host: Vercel, Netlify, Railway, etc.
```

On **Vercel**, set the root directory to `docs/` when importing the project.

### Web Deployment

#### Vercel (Recommended)

1. Push your code to GitHub/GitLab/Bitbucket
2. Import project on [Vercel](https://vercel.com/new)
3. Vercel auto-detects Next.js and deploys

#### Netlify

```bash
# Build command
pnpm build

# Publish directory
out
```

#### Static Hosting (Nginx, Apache, etc.)

1. Build the project: `pnpm build`
2. Upload the `out/` directory to your server
3. Configure server to serve static files

### Desktop Deployment

#### Windows

- Distribute the `.msi` installer from `src-tauri/target/release/bundle/msi/`
- Users run the installer to install the application

#### macOS

- Distribute the `.dmg` file from `src-tauri/target/release/bundle/dmg/`
- Users drag the app to Applications folder
- **Note**: For distribution outside the App Store, you need to sign the app with an Apple Developer certificate

#### Linux

- Distribute the `.AppImage` from `src-tauri/target/release/bundle/appimage/`
- Users make it executable and run: `chmod +x app.AppImage && ./app.AppImage`
- Alternative formats: `.deb` (Debian/Ubuntu), `.rpm` (Fedora/RHEL)

#### Code Signing (Recommended for Production)

- **Windows**: Use a code signing certificate
- **macOS**: Requires Apple Developer account and certificate
- **Linux**: Optional, but recommended for distribution

See [Tauri Distribution Guide](https://tauri.app/v1/guides/distribution/) for detailed instructions.

## Development Workflow

### Typical Development Cycle

1. **Start development server**

   ```bash
   pnpm dev  # For web development
   # or
   pnpm tauri dev  # For desktop development
   ```

2. **Make changes**
   - Edit files in `app/`, `components/`, or `lib/`
   - Changes auto-reload in the browser/desktop app

3. **Add new components**

   ```bash
   pnpm dlx shadcn@latest add [component-name]
   ```

4. **Lint your code**

   ```bash
   pnpm lint
   ```

5. **Build and test**

   ```bash
   pnpm build  # Test web build
   pnpm tauri build  # Test desktop build
   ```

### Best Practices

- **Code Style**: Follow ESLint rules (`pnpm lint`)
- **Commits**: Conventional Commits are enforced via the `commit-msg` hook (commitlint). After cloning, run `pnpm install` once — the `prepare` script auto-installs the hooks.
- **Components**: Keep components small and reusable
- **State**: Use Zustand for global state, React hooks for local state
- **Styling**: Use Tailwind utility classes, avoid custom CSS when possible
- **Types**: Leverage TypeScript for type safety

## Troubleshooting

### Common Issues

**Port 3000 already in use**

```bash
# Kill the process using port 3000
# Windows
netstat -ano | findstr :3000
taskkill /PID <PID> /F

# macOS/Linux
lsof -ti:3000 | xargs kill -9
```

**Tauri build fails**

```bash
# Check Tauri environment
pnpm tauri info

# Update Rust
rustup update

# Clean build cache
cd src-tauri
cargo clean
```

**Module not found errors**

```bash
# Clear Next.js cache
rm -rf .next

# Reinstall all workspace dependencies
rm -rf node_modules docs/node_modules pnpm-lock.yaml
pnpm install
```

**`Cannot find module 'collections/server'` in docs**

This module is auto-generated by fumadocs-mdx. Run the docs dev server once to generate it:

```bash
pnpm docs:dev
```

## Learn More

### Next.js Resources

- [Next.js Documentation](https://nextjs.org/docs) - Learn about Next.js features and API
- [Learn Next.js](https://nextjs.org/learn) - Interactive Next.js tutorial
- [Next.js GitHub](https://github.com/vercel/next.js) - Next.js repository

### Tauri Resources

- [Tauri Documentation](https://tauri.app/) - Official Tauri documentation
- [Tauri API Reference](https://tauri.app/v1/api/js/) - JavaScript API reference
- [Tauri GitHub](https://github.com/tauri-apps/tauri) - Tauri repository

### UI & Styling

- [shadcn/ui](https://ui.shadcn.com/) - Component library documentation
- [Tailwind CSS](https://tailwindcss.com/docs) - Tailwind CSS documentation
- [Radix UI](https://www.radix-ui.com/) - Radix UI primitives

### State Management

- [Zustand](https://zustand-demo.pmnd.rs/) - Zustand documentation

### Documentation

- [Fumadocs](https://fumadocs.dev/) - Fumadocs documentation framework

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is open source and available under the [MIT License](LICENSE).

## Support

If you encounter any issues or have questions:

- Check the [Troubleshooting](#troubleshooting) section
- Review [Next.js Documentation](https://nextjs.org/docs)
- Review [Tauri Documentation](https://tauri.app/)
- Open an issue on GitHub
