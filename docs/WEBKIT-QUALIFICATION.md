# WebKit qualification

Status: **container-backed local qualification path implemented for heterogeneous Linux hosts**

## Why native WebKit fails on this Arch host

Playwright's Linux WebKit bundle is built and qualified against a specific Ubuntu userspace. The current `@playwright/test` installation is 1.62.1 and its WebKit bundle expects, among other libraries, ICU 74 (`libicudata.so.74`, `libicui18n.so.74`, `libicuuc.so.74`), `libxml2.so.2`, Flite 1, and the older JPEG XL ABI. This Arch host provides newer incompatible SONAMEs such as ICU 78, `libxml2.so.16`, and JPEG XL 0.12.

Creating compatibility symlinks from the expected SONAMEs to newer ABIs would make the browser launch less reproducible and could turn ABI corruption into misleading application failures. The repository therefore does **not** patch `/usr/lib`, downgrade system packages, or treat the host launch failure as a product failure.

## Supported paths

### Native host / CI

On a Playwright-supported Linux image with the matching browser dependencies installed:

```bash
pnpm test:e2e:webkit:host
```

GitHub workflows continue to install browser dependencies with Playwright's `--with-deps` flow before running the normal browser matrix.

### Reproducible local fallback

On hosts whose system libraries do not match Playwright WebKit:

```bash
pnpm test:e2e:webkit
```

The command runs `scripts/test-webkit-container.sh`. It:

1. reads the **installed** `@playwright/test` version;
2. selects the exact matching `mcr.microsoft.com/playwright:v<version>-noble` image;
3. fails closed if its two requested local ports are already occupied;
4. starts the toy Signal service and a production Vite preview on the host;
5. runs only the WebKit Playwright process in the matching container with Linux host networking;
6. mounts the repository at `/work`, but runs as the caller's UID/GID so traces/screenshots are never left root-owned;
7. explicitly tells Playwright to reuse the already-started host servers rather than spawning package-manager processes in the container;
8. cleans up the host servers when the browser run exits.

The first invocation may pull the matching Playwright image. Once cached, the browser userspace is independent of host ICU/XML/Flite package churn.

Ports are overrideable without editing the Playwright config:

```bash
E2E_COL_TEST_TOY_PORT=28217 \
E2E_COL_TEST_WEB_PORT=4274 \
pnpm test:e2e:webkit
```

The ordinary `playwright.config.ts` accepts the same `E2E_COL_TEST_WEB_PORT`; this also prevents unrelated local preview servers from forcing E2E onto a hard-coded port.

## Release-gate semantics

`pnpm check:release` now means:

1. canonical repository check;
2. native Chromium + Firefox E2E;
3. WebKit through the exact-version container fallback.

This is a **browser-userspace portability fix**, not a claim that Docker itself is part of the production architecture. Application bytes, identity/E2EE behavior, storage, authorization, and the toy Signal service are unchanged.

## Security and reproducibility notes

- Do not run the WebKit container with application secrets. The qualification profile uses the repository's toy/local services only.
- The script uses `--network host` because the browser must reach the two loopback services started by the host script. It does not expose or provision Signal accounts.
- The Playwright image version is derived from the installed package rather than a floating tag, preventing package/browser protocol skew.
- CI remains the authoritative supported-host WebKit gate. The container path gives developers on rolling distributions a way to reproduce that browser family without mutating their system libraries.
