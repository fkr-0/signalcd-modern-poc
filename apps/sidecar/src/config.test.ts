import { describe, expect, it } from 'vitest'
import { readSidecarRuntimeConfig } from './config'

const documentId = '11111111-1111-4111-8111-111111111111'
const groupId = 'Z3JvdXAtYQ=='

function baseEnv(): Record<string, string> {
  return {
    E2E_COL_DOCUMENT_GROUPS: JSON.stringify({ [documentId]: groupId }),
    E2E_COL_SIGNAL_BODY_MAX_BYTES: '1900'
  }
}

describe('readSidecarRuntimeConfig', () => {
  it('defaults to loopback endpoints without introducing browser Signal credentials', () => {
    expect(readSidecarRuntimeConfig(baseEnv())).toEqual({
      signalCliHttpUrl: 'http://127.0.0.1:8080',
      documentGroups: { [documentId]: groupId },
      sidecarHost: '127.0.0.1',
      sidecarPort: 43127,
      signalBodyMaxBytes: 1900
    })
  })

  it('accepts explicit account, endpoint, port, and normalized origin allowlist', () => {
    expect(
      readSidecarRuntimeConfig({
        ...baseEnv(),
        SIGNAL_CLI_HTTP_URL: 'http://localhost:9090',
        SIGNAL_CLI_ACCOUNT: '+49123',
        E2E_COL_SIDECAR_PORT: '43128',
        E2E_COL_ALLOWED_ORIGINS: 'http://localhost:4174, http://127.0.0.1:4174/'
      })
    ).toMatchObject({
      signalCliHttpUrl: 'http://localhost:9090',
      signalCliAccount: '+49123',
      sidecarPort: 43128,
      allowedOrigins: ['http://localhost:4174', 'http://127.0.0.1:4174']
    })
  })

  it('requires an explicit Signal body boundary rather than guessing a production limit', () => {
    const env = baseEnv()
    delete env.E2E_COL_SIGNAL_BODY_MAX_BYTES
    expect(() => readSidecarRuntimeConfig(env)).toThrow(/E2E_COL_SIGNAL_BODY_MAX_BYTES/)
  })

  it('rejects malformed or ambiguous document-to-group mappings', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_DOCUMENT_GROUPS: JSON.stringify({ not_a_uuid: groupId })
      })
    ).toThrow(/document UUID/)
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_DOCUMENT_GROUPS: JSON.stringify({ [documentId]: 'not-base64' })
      })
    ).toThrow(/group ID/)
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_DOCUMENT_GROUPS: JSON.stringify({
          [documentId]: groupId,
          '22222222-2222-4222-8222-222222222222': groupId
        })
      })
    ).toThrow(/one document/)
  })

  it('rejects origins with credentials or request paths', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_ALLOWED_ORIGINS: 'http://user:secret@localhost:4174'
      })
    ).toThrow(/credential-free/)
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_ALLOWED_ORIGINS: 'http://localhost:4174/app'
      })
    ).toThrow(/without path/)
  })

  it('rejects a non-JSON document groups value', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_DOCUMENT_GROUPS: 'not-json'
      })
    ).toThrow(/valid JSON/)
  })

  it('rejects an empty JSON object for document groups', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_DOCUMENT_GROUPS: '{}'
      })
    ).toThrow(/non-empty/)
  })

  it('rejects an array for document groups', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_DOCUMENT_GROUPS: '[]'
      })
    ).toThrow(/non-empty/)
  })

  it('rejects port values outside the valid range', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_SIDECAR_PORT: '0'
      })
    ).toThrow(/positive integer/)
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_SIDECAR_PORT: '65536'
      })
    ).toThrow(/between 1 and 65535/)
  })

  it('rejects a non-positive signal body max bytes', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_SIGNAL_BODY_MAX_BYTES: '0'
      })
    ).toThrow(/positive integer/)
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_SIGNAL_BODY_MAX_BYTES: '-100'
      })
    ).toThrow(/positive integer/)
  })

  it('rejects an empty signal CLI account when explicitly configured', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        SIGNAL_CLI_ACCOUNT: '   '
      })
    ).toThrow(/non-empty/)
  })

  it('omits optional fields when not configured', () => {
    const config = readSidecarRuntimeConfig(baseEnv())
    expect(config).not.toHaveProperty('signalCliAccount')
    expect(config).not.toHaveProperty('allowedOrigins')
  })

  it('deduplicates normalized origins', () => {
    const config = readSidecarRuntimeConfig({
      ...baseEnv(),
      E2E_COL_ALLOWED_ORIGINS: 'http://localhost:4174, http://localhost:4174/'
    })
    expect(config.allowedOrigins).toEqual(['http://localhost:4174'])
  })

  it('rejects origins with query strings or fragments', () => {
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_ALLOWED_ORIGINS: 'http://localhost:4174?foo=bar'
      })
    ).toThrow(/without path/)
    expect(() =>
      readSidecarRuntimeConfig({
        ...baseEnv(),
        E2E_COL_ALLOWED_ORIGINS: 'http://localhost:4174#section'
      })
    ).toThrow(/without path/)
  })
})
