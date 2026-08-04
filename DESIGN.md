# Recorder (WASM) — design notes

Status: **implemented** (see [`README.md`](./README.md)).  
Sibling: [`debug-store`](../debug-store/) (persistence sink).  
Kernel model: [`ts-kernel/README.md`](../ts-kernel/README.md) — *Process recording and replay*.

This document captures agreed decisions. Update it when the design changes.

---

## Goal

A portable **C++ WASM** module that:

1. Starts recording of one or more target processes via **kernel-shield** (`monitor` + `save`).
2. Keeps an in-RAM **replay window**: last snapshot + I/O events after that snapshot.
3. Forwards **logs / spans / metrics** immediately to **debug-store** (not kept in RAM).
4. On **error** (and optionally via API): dumps the current window (snapshot + I/O) to debug-store.
5. Rotates the window when the I/O byte buffer exceeds a threshold relative to the **current** snapshot size (request next `save`; cut only when both new memory and `process_save_event` are available).

Recording I/O + snapshots is critical for post-mortem replay. Logs/spans/metrics are secondary live telemetry.

---

## Roles

| Piece | Responsibility |
|-------|----------------|
| **Kernel** | Emits ordered monitor events; `save` returns `save_result`; backpressure via socket buffers |
| **kernel-shield** | Capability boundary; forwards full kernel `monitor(…, config)` and `save` → `save_result` |
| **recorder** (this module) | Multi-target capture policy, RAM window, rotation, dump triggers, log forward; **is the monitor** (calls `monitor` itself) |
| **debug-store** | Durable session files via ts-fs; recorder is a `begin` + session client |

Host-only FS stays in `ts-fs`. Recorder does not touch the filesystem directly.

---

## Per-target `record_config`

| Field | Meaning |
|-------|---------|
| `event_buffer_snapshot_mult` | `1` or `2` only (else `recorder_invalid_argument`). Threshold = `k * anchor.memory.size()` |
| `record_mana` | If true, subscribe/append `MANA` monitor frames (`process_measure_mana_event` / `process_set_mana_limit_event`) |
| `dump_on_error` | If true, auto-dump complete window on `process_error_event` (do **not** seal store) |

---

## Topology (conceptual)

```
                    USER RPC (start/stop/dump/rotate)
Client ───────────────────────────────────────────► recorder.wasm
                                                         │
              per-target MONITOR socket (kernel events)  │
              per-target LOG ingress socket              │
              kernel-shield API (monitor/save/bind)      │
                                                         ▼
                                                   kernel-shield → kernel

recorder ── debug_store.begin + session ──► debug-store.wasm ──► ts-fs
              live: logs / spans / metrics
              dump: snapshot + opaque I/O frames
```

- **One recorder process, many targets**: each target → own monitor socket, own log ingress socket, own RAM window / state machine.
- Recorder calls `monitor(target, recorder_pid, monitor_socket, config)` and `save(target)` itself.
- Host binds `recorder.SHIELD (1) ↔ kernel-shield.USER (0)` before start.
- On `start_recording`, recorder uses `shield.bind` to attach to debug-store USER then session socket.

### Socket map

| ID | Role |
|----|------|
| 0 | USER — `recorder` RPC |
| 1 | SHIELD — outbound to kernel-shield |
| ≥2 | dynamic: per-target monitor, log ingress, store USER (temp), store session |

---

## Starting a recording

1. Validate `record_config` (`event_buffer_snapshot_mult` ∈ {1,2}).
2. `debug_store.begin(…)` → bind session socket. Session **lives until recording stop**.
3. Open **monitor** + **log ingress** sockets for this target.
4. `monitor(target, recorder, monitor_socket, config)` via shield.
5. Mandatory initial `save(target)`; wait until **both** `save_result` and matching `process_save_event` install the first anchor.
6. Start-recording RPC returns only when setup is done.

**Events before the first complete anchor** are **discarded**.

`INITIAL_BUFFER_*` / `BUFFER_*` are **not** subscribed.

---

## In-RAM window (per target)

```
anchor:  save_result { snapshot_uid, memory, mana_used, mana_limit }
io_bytes: append of whole length-prefixed monitor wire frames (opaque)
state:   Starting | Idle | RotatePending | Dumping | Stopping
```

### Appended to `io_bytes` (raw frames)

- `COPY` (+ payload when `COPY_PAYLOAD`), `DATA`, `DRAIN`
- `MANA` frames iff `record_mana`
- Not: `SAVE` (cut marker only), `INITIAL_*`, `BUFFER_*`, `KILLED` (no dump), bare `ERROR` (trigger only)

### Byte threshold

- Limit is **bytes only**.
- Threshold = **k × size of the current anchored snapshot** (`memory.size()`).
- After cut, threshold follows the new snapshot size.

---

## Snapshot / event pairing and rotation

- **Cut rule:** install new anchor only when **both** `save_result` and `process_save_event` share the same `snapshot_uid`. Drop buffered frames **up to and including** that save-event (new window is only I/O after the cut). Until both halves exist, keep the **previous** complete window (dump-during-rotation).
- Save-event frames are **not** retained in `io_bytes` (avoids inflating the rotate threshold with marker frames).

| State | Meaning |
|-------|---------|
| `Starting` | Waiting for first complete anchor |
| `Idle` | Complete anchor; appending I/O; may rotate on byte threshold |
| `RotatePending` | New save in flight / partially observed; append still against previous anchor |
| `Dumping` | Persist window to debug-store |
| `Stopping` | Tearing down |

**Dump during `RotatePending`:** dump the **previous** complete snapshot + its `io_bytes`.

**API:** `dump` (no window change), `rotate` (force save + cut). `dump_and_rotate` — **not in v1**.

---

## Dump → debug-store (write-optimized)

1. `debug_snapshot_event {uid, mana_*}` + trailing = `anchor.memory`
2. One (or chunked) `debug_io_event` + trailing = **opaque** concatenation of raw monitor frames in `io_bytes` — **no** re-parse/re-encode of Copy/Data/Drain
3. `debug_session.sync`
4. Window unchanged (unless a separate `rotate`)

Seal/fail store only on **`stop_recording`**.

---

## Monitor flags (v1)

Always: `COPY | COPY_PAYLOAD | DATA | DRAIN | SAVE | ERROR`  
If `record_mana`: `|= MANA`  
No `INITIAL_*` / `BUFFER_*`.

---

## Closed decisions (changelog)

| Topic | Decision |
|-------|----------|
| Threshold | `k ∈ {1,2}` × last installed snapshot byte size |
| I/O in dump | Opaque raw monitor wire frames |
| Store session lifetime | Until **stop recording** |
| Log ingress | Socket per target; forward 1:1 to store |
| Who monitors | **Recorder** calls `monitor` |
| dump_and_rotate | Not in v1 |
| Shield API | Synced: `monitor_config` + `save_result` |

