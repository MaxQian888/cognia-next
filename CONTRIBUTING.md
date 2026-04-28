# Contributing to React Quick Starter

Thank you for your interest in contributing to React Quick Starter! This document provides guidelines and instructions for contributing.

## Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Making Changes](#making-changes)
- [Commit Guidelines](#commit-guidelines)
- [Pull Request Process](#pull-request-process)
- [Coding Standards](#coding-standards)
- [Testing](#testing)
- [Documentation](#documentation)

## Code of Conduct

See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/react-quick-starter.git
   cd react-quick-starter
   ```
3. **Add the upstream remote**:
   ```bash
   git remote add upstream https://github.com/AstroAir/react-quick-starter.git
   ```

## Development Setup

### Prerequisites

- **Node.js** 20.x or later
- **pnpm** 8.x or later
- **Rust** 1.70+ (for Tauri development)

### Installation

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# For Tauri desktop development
pnpm tauri dev
```

### Verify Setup

```bash
# Run linting
pnpm lint

# Run tests
pnpm test

# Check Tauri environment
pnpm tauri info
```

## Making Changes

### Branch Naming

Create a feature branch from `main`:

```bash
git checkout main
git pull upstream main
git checkout -b <type>/<description>
```

Branch types:

- `feat/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation changes
- `refactor/` - Code refactoring
- `test/` - Test additions or modifications
- `chore/` - Maintenance tasks

Examples:

- `feat/add-dark-mode-toggle`
- `fix/navigation-scroll-issue`
- `docs/update-installation-guide`

### Keep Your Fork Updated

```bash
git fetch upstream
git checkout main
git merge upstream/main
```

## Commit Guidelines

We follow [Conventional Commits](https://www.conventionalcommits.org/) specification.

### Commit Message Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type       | Description                                             |
| ---------- | ------------------------------------------------------- |
| `feat`     | New feature                                             |
| `fix`      | Bug fix                                                 |
| `docs`     | Documentation only                                      |
| `style`    | Code style (formatting, semicolons, etc.)               |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf`     | Performance improvement                                 |
| `test`     | Adding or updating tests                                |
| `build`    | Build system or external dependencies                   |
| `ci`       | CI/CD configuration                                     |
| `chore`    | Other changes that don't modify src or test files       |
| `revert`   | Reverts a previous commit                               |

### Examples

```bash
feat(ui): add Button component variants
fix(auth): resolve token refresh loop
docs(readme): update installation instructions
refactor(utils): simplify cn helper function
test(button): add accessibility tests
```

## Pull Request Process

1. **Update your branch** with the latest upstream changes
2. **Run all checks locally**:
   ```bash
   pnpm lint
   pnpm test
   pnpm build
   ```
3. **Push your branch** to your fork
4. **Create a Pull Request** against `main`
5. **Fill out the PR template** completely
6. **Request review** from maintainers
7. **Address feedback** and make requested changes
8. **Squash commits** if requested

### PR Checklist

- [ ] Code follows project style guidelines
- [ ] Self-reviewed the code
- [ ] Added/updated tests as needed
- [ ] Updated documentation as needed
- [ ] All CI checks pass
- [ ] Linked related issues

## Coding Standards

**Tooling enforcement** (auto-runs on commit):

- **Prettier** formats staged files via `lint-staged`
- **ESLint --fix** runs on staged TS/JS files
- **commitlint** validates commit messages against Conventional Commits

First-time setup: `pnpm install` — the `prepare` script installs git hooks via Husky. If hooks don't fire, run `pnpm exec husky` manually.

### TypeScript

- Use TypeScript for all new code
- Enable strict mode
- Avoid `any` type; use proper typing
- Export types from dedicated type files when shared

### React

- Use functional components with hooks
- Follow React 19 best practices
- Keep components small and focused
- Use proper prop typing

### Styling

- Use Tailwind CSS utility classes
- Follow the existing design system
- Use CSS variables for theming
- Avoid inline styles

### File Organization

```
components/
├── ui/           # shadcn/ui components
│   └── button.tsx
├── feature/      # Feature-specific components
│   └── header.tsx
└── index.ts      # Barrel exports
```

### Naming Conventions

| Type             | Convention                  | Example           |
| ---------------- | --------------------------- | ----------------- |
| Components       | PascalCase                  | `UserProfile.tsx` |
| Hooks            | camelCase with `use` prefix | `useAuth.ts`      |
| Utilities        | camelCase                   | `formatDate.ts`   |
| Types/Interfaces | PascalCase                  | `UserData`        |
| Constants        | SCREAMING_SNAKE_CASE        | `MAX_RETRIES`     |

## Testing

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run with coverage
pnpm test:coverage
```

### Writing Tests

- Place tests next to source files: `Component.test.tsx`
- Use React Testing Library for component tests
- Test behavior, not implementation details
- Aim for meaningful coverage, not 100%

### Test Structure

```typescript
import { render, screen } from '@testing-library/react'
import { Button } from './button'

describe('Button', () => {
  it('renders children correctly', () => {
    render(<Button>Click me</Button>)
    expect(screen.getByRole('button')).toHaveTextContent('Click me')
  })

  it('handles click events', async () => {
    const handleClick = jest.fn()
    render(<Button onClick={handleClick}>Click</Button>)
    await userEvent.click(screen.getByRole('button'))
    expect(handleClick).toHaveBeenCalledTimes(1)
  })
})
```

## Documentation

### When to Update Docs

- Adding new features
- Changing existing behavior
- Updating dependencies
- Modifying configuration

### Documentation Files

- `README.md` - Project overview and quick start
- `README_zh.md` - Chinese documentation
- `CONTRIBUTING.md` - This file
- `CI_CD.md` - CI/CD setup guide
- `TESTING.md` - Testing guide

### Code Comments

- Use JSDoc for public APIs
- Explain "why", not "what"
- Keep comments up to date

## Questions?

If you have questions, feel free to:

1. Check existing [Issues](https://github.com/AstroAir/react-quick-starter/issues)
2. Open a new issue for discussion
3. Reach out to maintainers

Thank you for contributing! 🎉
