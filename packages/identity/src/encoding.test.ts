import { describe, expect, it } from 'vitest'
import {
  base64ToBytes,
  bytesToBase64,
  exportRawKey,
  importEd25519Public,
  importX25519Public
} from './encoding'

describe('bytesToBase64 and base64ToBytes roundtrip', () => {
  it('round-trips an arbitrary byte sequence through base64', () => {
    const original = new Uint8Array([0, 1, 2, 127, 128, 254, 255])
    const encoded = bytesToBase64(original)
    expect(typeof encoded).toBe('string')
    expect(encoded.length).toBeGreaterThan(0)
    const decoded = base64ToBytes(encoded)
    expect(decoded).toEqual(original)
  })

  it('round-trips an empty byte array', () => {
    const empty = new Uint8Array(0)
    expect(bytesToBase64(empty)).toBe('')
    expect(base64ToBytes('')).toEqual(empty)
  })

  it('round-trips a single-byte array', () => {
    const single = new Uint8Array([42])
    expect(base64ToBytes(bytesToBase64(single))).toEqual(single)
  })

  it('round-trips a 256-byte array covering all byte values', () => {
    const allBytes = new Uint8Array(256)
    for (let i = 0; i < 256; i += 1) allBytes[i] = i
    expect(base64ToBytes(bytesToBase64(allBytes))).toEqual(allBytes)
  })

  it('base64ToBytes produces correct length', () => {
    const bytes = new Uint8Array([10, 20, 30, 40, 50])
    const encoded = bytesToBase64(bytes)
    const decoded = base64ToBytes(encoded)
    expect(decoded.byteLength).toBe(5)
  })
})

describe('Ed25519 public key import and export', () => {
  it('imports a raw Ed25519 public key and exports it back to the same base64', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const exported = await exportRawKey(keyPair.publicKey)
    expect(typeof exported).toBe('string')
    expect(exported.length).toBeGreaterThan(0)

    const imported = await importEd25519Public(exported)
    expect(imported.type).toBe('public')
    expect(imported.algorithm).toEqual({ name: 'Ed25519' })
    expect(imported.usages).toEqual(['verify'])

    const reExported = await exportRawKey(imported)
    expect(reExported).toBe(exported)
  })

  it('generates a 32-byte raw Ed25519 public key', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const raw = await exportRawKey(keyPair.publicKey)
    const decoded = base64ToBytes(raw)
    expect(decoded.byteLength).toBe(32)
  })
})

describe('X25519 public key import and export', () => {
  it('imports a raw X25519 public key and exports it back to the same base64', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    const exported = await exportRawKey(keyPair.publicKey)
    expect(typeof exported).toBe('string')

    const imported = await importX25519Public(exported)
    expect(imported.type).toBe('public')
    expect(imported.algorithm).toEqual({ name: 'X25519' })
    expect(imported.usages).toEqual([])

    const reExported = await exportRawKey(imported)
    expect(reExported).toBe(exported)
  })

  it('generates a 32-byte raw X25519 public key', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    const raw = await exportRawKey(keyPair.publicKey)
    const decoded = base64ToBytes(raw)
    expect(decoded.byteLength).toBe(32)
  })
})
