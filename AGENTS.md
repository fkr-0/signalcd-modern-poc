# AGENTS.md - e2e-col

## Stack

- **Package Manager**: pnpm (workspaces)
- **Linter/Formatter**: Biome
- **Build Tool**: Vite (apps/web)
- **Test Framework**: Vitest + Playwright (e2e)
- **Language**: TypeScript

## Commands

```bash
# Install dependencies
pnpm install

# Development
pnpm dev

# Build
pnpm build

# Lint & Format
pnpm lint           # Check with Biome
pnpm format         # Auto-fix with Biome

# Type check
pnpm typecheck

# Tests
pnpm test           # Unit tests (Vitest)
pnpm test:e2e       # E2E tests (Playwright)
pnpm test:watch     # Watch mode

# Full check
pnpm check          # typecheck + lint + format + test + build
```

## Project Structure

```
apps/
  web/          - React frontend (Vite)
  sidecar/      - WebSocket relay server
  toy-signal-cli/ - Signal protocol demo CLI
  android/      - Native Kotlin Android client (Gradle, Compose)
packages/
  core/         - Core CRDT/encryption logic
  protocol/     - Signal protocol implementation
  storage/      - IndexedDB persistence layer
  transport/    - WebRTC transport layer
  testing/      - Test utilities
```

## Workspace Dependencies

Internal packages reference each other via `"@e2e-col/*": "workspace:*"` in package.json.
Use `pnpm --filter <pkg>` to run commands in specific packages.

## Rules

- Always use `pnpm`, never `npm` or `yarn`
- Use `biome check --write` for formatting (replaces prettier + eslint)
- Use `biome check` for linting
- Use `vitest` for unit tests
- Use `playwright` for e2e tests
- Use `vite` for web app bundling
