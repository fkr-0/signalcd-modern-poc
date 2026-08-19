# @e2e-col/protocol

Versioned, transport-neutral wire protocol for collaborative document updates.
The package has no runtime dependencies and is safe to use from both browser
and Node.js boundaries.

## Envelope v1

Every logical frame carries:

- protocol version (`1`);
- UUID document and message identifiers;
- an opaque sender/device identifier;
- a closed frame kind (`automerge-change`, `snapshot`, `membership`, `archive`,
  `delete`, `health`, or `chunk`);
- non-negative millisecond creation time and optional local sequence number;
- raw binary payload.

Chunk frames additionally identify their zero-based index, total chunk count,
original logical message ID, and original non-chunk kind. Each physical chunk
has its own message ID so transport-level deduplication does not collapse a
multi-frame message.

## Binary layout

All integers are unsigned big-endian. Strings are UTF-8 with a 16-bit byte
length. Payloads have a 32-bit byte length.

```text
magic "E2EC"         4 bytes
protocol version      u8
frame kind code       u8
flags                 u8 (bit 0: sequence, bit 1: chunk metadata)
createdAt             u64
sequence              u64, when flagged
documentId            u16 length + UTF-8
messageId             u16 length + UTF-8
senderId              u16 length + UTF-8
chunk.index           u32, for chunk frames
chunk.total           u32, for chunk frames
chunk.originalId      u16 length + UTF-8, for chunk frames
chunk.originalKind    u8, for chunk frames
payload               u32 length + bytes
```

Unknown protocol versions, frame kinds, flags, fields, malformed UUIDs, invalid
UTF-8, truncated frames, trailing bytes, and payloads larger than 16 MiB are
rejected. The tests include a fixed v1 wire vector so accidental format drift is
visible immediately.

## Chunking and deduplication

`chunkEnvelope` defaults to 32 KiB payload slices and caps one logical payload at
16 MiB / 4096 chunks. `reassembleChunks` accepts shuffled input and identical
transport duplicates, rejects conflicting duplicates or mixed metadata, and
checks the total size before allocation.

`DedupCache` provides bounded document/message-ID deduplication with an LRU-like
insertion bound and sliding TTL. It is process-local policy state; durable queue
or replay persistence belongs in the storage layer.

## Public API

```ts
import {
  createEnvelope,
  encodeEnvelope,
  decodeEnvelope,
  chunkEnvelope,
  reassembleChunks,
  DedupCache
} from '@e2e-col/protocol'
```
