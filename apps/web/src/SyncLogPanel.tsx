import type { SyncLogClient, SyncLogDirection, SyncLogEntry, SyncLogLevel } from '@e2e-col/identity'
import { useEffect, useMemo, useRef, useState } from 'react'
import './sync-log-panel.css'

const levels: readonly SyncLogLevel[] = ['wire', 'envelope', 'application', 'decrypted']

interface PanelEntry {
  readonly id: number
  readonly entry: SyncLogEntry
}

export function SyncLogPanel({ client }: { readonly client: SyncLogClient }) {
  const [entries, setEntries] = useState<readonly PanelEntry[]>([])
  const nextEntryIdRef = useRef(0)
  const [level, setLevel] = useState<SyncLogLevel | 'all'>('all')
  const [direction, setDirection] = useState<SyncLogDirection | 'all'>('all')
  const [collapsed, setCollapsed] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [exporting, setExporting] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const unsubscribe = client.subscribe((entry) => {
      const id = nextEntryIdRef.current
      nextEntryIdRef.current += 1
      setEntries((current) => [...current, { id, entry }])
    })
    client.connect()
    return () => {
      unsubscribe()
      client.disconnect()
    }
  }, [client])

  const visible = useMemo(
    () =>
      entries.filter(
        ({ entry }) =>
          (level === 'all' || entry.level === level) &&
          (direction === 'all' || entry.direction === direction)
      ),
    [direction, entries, level]
  )

  useEffect(() => {
    if (!hovered && !collapsed && visible.length > 0)
      scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight })
  }, [collapsed, hovered, visible.length])

  async function exportLog() {
    if (exporting) return
    setExporting(true)
    try {
      const all = await client.getLogSince(0)
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' })
      )
      const link = document.createElement('a')
      link.href = url
      link.download = `e2e-col-sync-log-${new Date().toISOString().replaceAll(':', '-')}.json`
      link.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="sync-log-panel" aria-label="Sync log">
      <header className="sync-log-header">
        <button
          type="button"
          className="sync-log-collapse"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
        >
          <span aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          Sync log
          <small>{entries.length} events</small>
        </button>
        <div className="sync-log-controls">
          <label>
            <span>Level</span>
            <select
              value={level}
              onChange={(event) => setLevel(event.target.value as SyncLogLevel | 'all')}
            >
              <option value="all">All</option>
              {levels.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Direction</span>
            <select
              value={direction}
              onChange={(event) => setDirection(event.target.value as SyncLogDirection | 'all')}
            >
              <option value="all">All</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </label>
          <button
            type="button"
            className="sync-log-export"
            onClick={() => void exportLog()}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export JSON'}
          </button>
        </div>
      </header>
      {!collapsed ? (
        <div
          ref={scrollerRef}
          role="feed"
          className="sync-log-events"
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          {visible.length === 0 ? (
            <p className="sync-log-empty">No matching sync events yet.</p>
          ) : (
            visible.map(({ id, entry }) => <SyncLogRow key={id} entry={entry} />)
          )}
        </div>
      ) : null}
    </section>
  )
}

function SyncLogRow({ entry }: { readonly entry: SyncLogEntry }) {
  return (
    <article className={`sync-log-row level-${entry.level}`}>
      <time dateTime={new Date(entry.timestamp).toISOString()}>
        {formatTimestamp(entry.timestamp)}
      </time>
      <strong>{entry.level}</strong>
      <span>{entry.direction ?? '—'}</span>
      <code>{entry.envelopeKind ?? entry.documentId?.slice(0, 8) ?? 'wire'}</code>
      <span className="sync-log-route">
        {entry.senderPhone ?? '—'} → {entry.recipientPhone ?? '—'}
      </span>
      <span className="sync-log-detail">
        {entry.preview ??
          (entry.rawSizeBytes === undefined ? (entry.messageId ?? '—') : `${entry.rawSizeBytes} B`)}
      </span>
    </article>
  )
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  }).format(timestamp)
}
