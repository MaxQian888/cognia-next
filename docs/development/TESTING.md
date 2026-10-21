# Testing Guide

This document provides information about the testing setup and how to run tests in this project.

## Testing Stack

- **Test Runner**: Jest 30.x
- **Testing Library**: @testing-library/react 16.x
- **Test Environment**: jsdom (simulates browser environment)
- **Coverage Provider**: V8
- **CI/CD**: GitHub Actions

## Running Tests

### Run all tests

```bash
pnpm test
```

### Run tests in watch mode

```bash
pnpm test:watch
```

### Run tests with coverage

```bash
pnpm test:coverage
```

### Run specific test file

```bash
pnpm test path/to/test-file.test.tsx
```

### Run tests matching a pattern

```bash
pnpm test --testNamePattern="Button"
```

## Test File Structure

### Test File Organization

Tests are **collocated** with their source files:

- `app/page.tsx` → `app/page.test.tsx`
- `lib/utils.ts` → `lib/utils.test.ts`
- `components/ui/button.tsx` → `components/ui/button.test.tsx`

There is **no** `__tests__/` directory. Jest discovers `*.test.{ts,tsx}` anywhere under `app/`, `components/`, and `lib/` (see `testMatch` in `jest.config.ts`).

Test files should be placed next to the files they test with the `.test.ts` or `.test.tsx` extension:

```
components/
  ui/
    button.tsx
    button.test.tsx  ← Test file
app/
  page.tsx
  page.test.tsx      ← Test file
lib/
  utils.ts
  utils.test.ts      ← Test file
```

## Writing Tests

### Component Test Example

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './button';

describe('Button', () => {
  it('renders a button with text', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole('button', { name: /click me/i })).toBeInTheDocument();
  });

  it('handles click events', async () => {
    const handleClick = jest.fn();
    const user = userEvent.setup();

    render(<Button onClick={handleClick}>Click me</Button>);
    await user.click(screen.getByRole('button'));

    expect(handleClick).toHaveBeenCalledTimes(1);
  });
});
```

### Utility Function Test Example

```typescript
import { cn } from "./utils"

describe("cn utility function", () => {
  it("merges class names correctly", () => {
    const result = cn("class1", "class2")
    expect(result).toBe("class1 class2")
  })
})
```

## Coverage Reports

After running `pnpm test:coverage`, coverage reports are generated in the `coverage/` directory:

- **HTML Report**: `coverage/index.html` - Open in browser for interactive coverage report
- **LCOV Report**: `coverage/lcov.info` - For CI/CD integration
- **JUnit XML**: `coverage/junit.xml` - For CI/CD test result reporting
- **Clover XML**: `coverage/clover.xml` - Alternative coverage format

### Viewing Coverage Report

Open the HTML coverage report in your browser:

```bash
# Windows
start coverage/index.html

# macOS
open coverage/index.html

# Linux
xdg-open coverage/index.html
```

## Jest Configuration

The Jest configuration is in `jest.config.ts` and includes:

- **Test Environment**: jsdom for React component testing
- **Setup File**: `jest.setup.ts` - Configures testing-library/jest-dom and mocks
- **Module Name Mapper**: Handles path aliases (@/components, @/lib, etc.)
- **Coverage Collection**: Configured to collect from app/, components/, and lib/ directories
- **Reporters**: Default console reporter + JUnit XML reporter for CI

## Mocked Modules

The following Next.js modules are automatically mocked in `jest.setup.ts`:

- `next/image` - Mocked to render as standard `<img>` tag
- `next/navigation` - Mocked router hooks (useRouter, usePathname, useSearchParams)

## CI/CD Integration

Tests run automatically on:

- Push to `master` or `develop` branches via `.github/workflows/ci.yml`
- Pull requests to `master` or `develop` branches via `.github/workflows/ci.yml`
- Version tags via `.github/workflows/release.yml`

The `test.yml` reusable workflow itself is invoked by `ci.yml`/`release.yml`, and can also be run manually with `workflow_dispatch` when you want to debug test/build steps in isolation.

The CI pipeline:

1. Installs dependencies
2. Runs linting (`pnpm lint`)
3. Runs tests with coverage (`pnpm test:coverage`)
4. Uploads coverage to Codecov (if configured)
5. Uploads test results and coverage as artifacts
6. Builds the Next.js application (`pnpm build`)

### GitHub Actions Workflow

The workflow is defined in `.github/workflows/ci.yml`.

### Setting up Codecov (Optional)

To enable Codecov integration:

1. Sign up at [codecov.io](https://codecov.io)
2. Add your repository
3. Add `CODECOV_TOKEN` to your GitHub repository secrets
4. Coverage will be automatically uploaded on each CI run

## Best Practices

### 1. Test Behavior, Not Implementation

❌ Bad:

```typescript
expect(component.state.count).toBe(1)
```

✅ Good:

```typescript
expect(screen.getByText("Count: 1")).toBeInTheDocument()
```

### 2. Use Accessible Queries

Prefer queries that reflect how users interact with your app:

1. `getByRole` - Best for most elements
2. `getByLabelText` - Good for form fields
3. `getByPlaceholderText` - For inputs without labels
4. `getByText` - For non-interactive elements
5. `getByTestId` - Last resort

### 3. Use User Events

Use `@testing-library/user-event` instead of `fireEvent`:

❌ Bad:

```typescript
fireEvent.click(button)
```

✅ Good:

```typescript
const user = userEvent.setup()
await user.click(button)
```

### 4. Clean Up After Tests

Jest automatically cleans up after each test, but if you create side effects:

```typescript
afterEach(() => {
  // Clean up
  jest.clearAllMocks()
})
```

### 5. Test Accessibility

```typescript
it('has accessible button', () => {
  render(<Button>Click me</Button>);
  const button = screen.getByRole('button', { name: /click me/i });
  expect(button).toBeInTheDocument();
});
```

## Troubleshooting

### Tests are slow

- Use `test.only()` to run a single test during development
- Use `pnpm test:watch` to run only changed tests

### Module not found errors

- Check that path aliases in `jest.config.ts` match `tsconfig.json`
- Ensure the module is properly mocked if it's a Next.js-specific module

### Coverage not collected

- Verify the file is in the `collectCoverageFrom` patterns in `jest.config.ts`
- Check that the file isn't in `coveragePathIgnorePatterns`

## Resources

- [Jest Documentation](https://jestjs.io/)
- [Testing Library Documentation](https://testing-library.com/docs/react-testing-library/intro/)
- [Testing Library Cheatsheet](https://testing-library.com/docs/react-testing-library/cheatsheet)
- [Common Testing Mistakes](https://kentcdodds.com/blog/common-mistakes-with-react-testing-library)
