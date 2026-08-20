export interface SidecarRuntimeConfig {
  readonly signalCliHttpUrl: string
  readonly signalCliAccount?: string
  readonly documentGroups: Readonly<Record<string, string>>
  readonly sidecarHost: string
  readonly sidecarPort: number
  readonly signalBodyMaxBytes: number
  readonly allowedOrigins?: readonly string[]
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export function readSidecarRuntimeConfig(
  env: Readonly<Record<string, string | undefined>>
): SidecarRuntimeConfig {
  const documentGroups = parseDocumentGroups(env.E2E_COL_DOCUMENT_GROUPS)
  const signalBodyMaxBytes = positiveInteger(
    env.E2E_COL_SIGNAL_BODY_MAX_BYTES,
    'E2E_COL_SIGNAL_BODY_MAX_BYTES'
  )
  const sidecarPort = optionalPort(env.E2E_COL_SIDECAR_PORT) ?? 43127
  const allowedOrigins = parseAllowedOrigins(env.E2E_COL_ALLOWED_ORIGINS)
  const signalCliAccount = nonEmptyOptional(env.SIGNAL_CLI_ACCOUNT, 'SIGNAL_CLI_ACCOUNT')

  return {
    signalCliHttpUrl: env.SIGNAL_CLI_HTTP_URL ?? 'http://127.0.0.1:8080',
    ...(signalCliAccount === undefined ? {} : { signalCliAccount }),
    documentGroups,
    sidecarHost: env.E2E_COL_SIDECAR_HOST ?? '127.0.0.1',
    sidecarPort,
    signalBodyMaxBytes,
    ...(allowedOrigins === undefined ? {} : { allowedOrigins })
  }
}

function parseDocumentGroups(value: string | undefined): Readonly<Record<string, string>> {
  if (!value) throw new Error('E2E_COL_DOCUMENT_GROUPS is required')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('E2E_COL_DOCUMENT_GROUPS must be valid JSON')
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new Error('E2E_COL_DOCUMENT_GROUPS must be a non-empty JSON object')
  }

  const result: Record<string, string> = {}
  const groupIds = new Set<string>()
  for (const [documentId, groupId] of Object.entries(parsed)) {
    if (!UUID_RE.test(documentId)) {
      throw new Error('E2E_COL_DOCUMENT_GROUPS contains an invalid document UUID')
    }
    if (typeof groupId !== 'string' || !isBase64(groupId)) {
      throw new Error('E2E_COL_DOCUMENT_GROUPS contains an invalid Signal group ID')
    }
    if (groupIds.has(groupId)) {
      throw new Error('E2E_COL_DOCUMENT_GROUPS must map each Signal group to one document')
    }
    groupIds.add(groupId)
    result[documentId] = groupId
  }
  return result
}

function parseAllowedOrigins(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const origins = value.split(',').map((entry) => entry.trim())
  if (origins.some((entry) => entry.length === 0)) {
    throw new Error('E2E_COL_ALLOWED_ORIGINS contains an empty origin')
  }
  return [...new Set(origins.map(normalizeOrigin))]
}

function normalizeOrigin(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('E2E_COL_ALLOWED_ORIGINS contains an invalid URL')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('E2E_COL_ALLOWED_ORIGINS must contain credential-free HTTP(S) origins')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(
      'E2E_COL_ALLOWED_ORIGINS entries must be origins without path, query, or fragment'
    )
  }
  return parsed.origin
}

function optionalPort(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const port = positiveInteger(value, 'E2E_COL_SIDECAR_PORT')
  if (port > 65_535) throw new Error('E2E_COL_SIDECAR_PORT must be between 1 and 65535')
  return port
}

function positiveInteger(value: string | undefined, name: string): number {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`)
  return parsed
}

function nonEmptyOptional(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined
  if (value.trim() === '') throw new Error(`${name} must be non-empty when configured`)
  return value
}

function isBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && BASE64_RE.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
