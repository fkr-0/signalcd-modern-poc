# SignalCD Modern PoC 0.0.6 — static web deployment

The browser application is a static Vite build. Local document editing, persisted identity material, the CRDT store, and the offline application shell do not require an application server. First-time identity registration, remote key lookup, and remote collaboration still require the configured identity/transport boundaries.

## Build

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm --filter @e2e-col/web build
```

The deployable tree is `apps/web/dist/`. Vite copies `public/_headers`, the PWA manifest, service worker, and icons into that directory.

Build-time configuration is compiled into the browser bundle. For a remote deployment, use TLS endpoints:

```sh
VITE_E2E_COL_IDENTITY_URL=https://identity.example.test \
VITE_E2E_COL_TRANSPORT=websocket \
VITE_E2E_COL_SIDECAR_URL=wss://sidecar.example.test/ws \
pnpm --filter @e2e-col/web build
```

Supported `VITE_E2E_COL_TRANSPORT` values are `deterministic`, `mock`, `peerjs`, and `websocket`. PeerJS deployments additionally use the variables documented in `docs/PEERJS-TRANSPORT.md` and should set `VITE_E2E_COL_PEERJS_SECURE=true` outside localhost.

Do not put long-lived server credentials in `VITE_*` variables: Vite values are public bundle configuration. The PeerJS rendezvous capability is a collaboration capability, not a server credential, and should still be distributed deliberately.

## Static-host requirements

Serve `apps/web/dist/` over HTTPS, except for localhost development. Configure SPA fallback so unknown application routes resolve to `index.html` while preserving real static assets such as `/sw.js`, `/manifest.webmanifest`, and `/assets/*`.

`public/_headers` contains a deployable baseline for hosts that support that convention (for example Netlify/Cloudflare Pages-style static headers):

- CSP with `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, and explicit worker/manifest boundaries;
- `Strict-Transport-Security: max-age=31536000` for HTTPS deployments;
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- restrictive camera/microphone/geolocation permissions;
- `Cross-Origin-Opener-Policy: same-origin`;
- no-cache service-worker delivery and immutable hashed assets.

Other hosts must translate those headers into their native configuration. The HTML also carries a CSP fallback, but `frame-ancestors` is effective only as an HTTP response header.

The shipped `connect-src` baseline permits HTTPS/WSS plus loopback development. A concrete deployment should narrow it to the exact identity, sidecar, and PeerJS origins it uses.

## PWA/offline behavior

On first online load, `/sw.js` installs a versioned application-shell cache and the page asks it to cache the loaded hashed Vite assets. A subsequent offline restart can serve the shell and restore the local identity/document state without contacting the identity provider.

When the browser implements Background Sync, the page registers the `signalcd-reconnect` tag. The worker treats it only as a wake-up notification for controlled clients. Encrypted durable outbound work remains in the application IndexedDB queue; the service worker does not receive or persist plaintext document keys or bearer tokens. Browsers without Background Sync use the ordinary reconnect/open replay path.

PWA installation prerequisites are the manifest, 192/512 PNG icons, service worker, HTTPS/localhost secure context, and `display: standalone`. Headless CI verifies those prerequisites and an actual offline restart. Browser/OS chrome such as Safari “Add to Home Screen” or Chromium's desktop install prompt must still be smoke-tested on the target release devices because Playwright does not drive browser installation chrome.

## Security/storage boundary

Current browser persistence uses:

- non-exportable Ed25519 runtime identity private keys;
- AES-GCM-wrapped X25519 private PKCS#8 material with non-exportable runtime re-import;
- AES-GCM-wrapped bearer session tokens using user-bound authenticated data;
- a non-exportable AES wrapping key stored by IndexedDB/WebCrypto;
- serialized remote public keys only.

This protects against casual/raw IndexedDB disclosure of private X25519 material and bearer strings, but it is not an OS keychain boundary: same-origin script execution can still use origin-held WebCrypto keys. The CSP and strict hosting policy are therefore part of the storage threat model.

## Release verification

```sh
pnpm run check
CI=1 E2E_COL_TEST_TOY_PORT=28216 E2E_COL_TEST_WEB_PORT=4273 \
  pnpm exec playwright test --project=chromium --project=firefox
pnpm run test:e2e:webkit
```

`pnpm run test:e2e:webkit` uses the repository's documented WebKit qualification path when the native host runtime cannot launch Playwright WebKit. See `docs/WEBKIT-QUALIFICATION.md`.

A deterministic static release archive can be produced from the verified tree with:

```sh
mkdir -p artifacts
tar --sort=name \
  --mtime='2026-09-11 00:00:00Z' \
  --owner=0 --group=0 --numeric-owner \
  -czf artifacts/signalcd-modern-poc-0.0.6-static.tar.gz \
  -C apps/web dist
sha256sum artifacts/signalcd-modern-poc-0.0.6-static.tar.gz \
  > artifacts/signalcd-modern-poc-0.0.6-static.tar.gz.sha256
```

The checked-in default browser configuration is intentionally localhost-oriented for development. Therefore an archive built without deployment-specific `VITE_*` values is a reproducible release-validation/local-demo artifact, **not** a drop-in remote production deployment. Before deploying to a real origin, rebuild with the exact TLS identity/transport endpoints above, rerun the release checks, regenerate the archive/checksum, and narrow `connect-src` to those endpoints.

Do not publish or retag `v0.0.5` with these fixes. `v0.0.5` already identifies an immutable earlier commit; this hardening line is `0.0.6`.
