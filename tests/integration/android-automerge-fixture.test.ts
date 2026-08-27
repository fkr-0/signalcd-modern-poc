import { readFileSync } from 'node:fs'
import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'

type FixtureDocument = { text: string }

const fixtureUrl = new URL(
  '../../apps/android/core/session/src/test/resources/ts-automerge-v1.base64',
  import.meta.url
)

describe('Android Automerge M1 fixture', () => {
  it('keeps the checked-in TypeScript snapshot readable and deterministic', () => {
    const snapshot = Buffer.from(readFileSync(fixtureUrl, 'utf8').trim(), 'base64')
    const document = Automerge.load<FixtureDocument>(snapshot)
    expect(document.text).toBe('ts-to-jvm')

    const edited = Automerge.change(document, (draft) => {
      Automerge.splice(draft, ['text'], draft.text.length, 0, ' + ts')
    })
    expect(edited.text).toBe('ts-to-jvm + ts')
  })
})
