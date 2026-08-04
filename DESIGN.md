# Recorder (WASM) — design notes

Status: **design only** (not implemented).  
Sibling: [`debug-store/`](../debug-store/) (persistence sink).  
Kernel model: [`ts-kernel/README.md`](../ts-kernel/README.md) — *Process recording and replay*.

This document captures agreed decisions before implementation. Update it when the design changes.

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
| **kernel-shield** | Capability boundary; must forward full kernel `monitor(…, config)` and `save` → `save_result` (see *Shield lag* below) |
| **recorder** (this module) | Multi-target capture policy, RAM window, rotation, dump triggers, log forward; **is the monitor** (calls `monitor` itself) |
| **debug-store** | Durable session files via ts-fs; recorder is a `begin` + session client |

Host-only FS stays in `ts-fs`. Recorder does not touch the filesystem directly.

### Shield lag (confirmed in tree)

Kernel contract (`cpp-rpc` / `ts-kernel`) already has:

- `monitor(target, monitor, monitor_socket, monitor_config)`
- `save(id) → save_result { snapshot_uid, memory, mana_used, mana_limit }`

**kernel-shield is behind** that update:

- Shield / `kernel_rpc` `monitor` takes **3 args** (no `monitor_config`); spawn-path `monitor(id, 1, MONITOR)` likewise.
- Shield `save` is typed as **`promise<binary>`**, not `save_result`.

This is incomplete shield sync with the kernel API — **must be fixed before recorder implementation**. ts-test mock already accepts `_config` when talking to the real kernel.

---

## Topology (conceptual)

```
                    USER RPC (start/stop/dump/rotate/…)
Client ───────────────────────────────────────────► recorder.wasm
                                                         │
              per-target MONITOR socket (kernel events)  │
              per-target LOG ingress socket              │
              kernel-shield API (monitor/save/…)         │
                                                         ▼
                                                   kernel-shield → kernel

recorder ── debug_store.begin + session ──► debug-store.wasm ──► ts-fs
              live: logs / spans / metrics
              dump: snapshot + I/O window
```

- **One recorder process, many targets**: each target → own monitor socket, own log ingress socket, own RAM window / state machine.
- **Monitor socket = monitoring only.**
- **Log/span/metric ingress = socket per target** (not multiplexed on one shared socket).
- Recorder calls `monitor(target, recorder_pid, monitor_socket, config)` and `save(target)` itself.

---

## Starting a recording

API shape TBD in codegen. Behaviour:

1. `debug_store.begin(…)` → bind session socket. Session **lives until recording stop** (so late log messages still in queues can be flushed).
2. Open **monitor** socket + **log ingress** socket for this target.
3. `monitor(target, recorder, monitor_socket, config)` via shield.
4. Mandatory initial `save(target)`.
5. Start-recording RPC returns only when setup is done.

**Events before the first `process_save_event`** for this recording are **discarded** (recording may start mid-lifetime).

`INITIAL_BUFFER_*` / `BUFFER_*` are **not** subscribed / not handled — buffer state is already inside linear memory in `save`.

---

## In-RAM window (per target)

```
anchor:  { snapshot_uid, memory, mana_used, mana_limit }  // memory from save RPC result
events:  byte-append FIFO of I/O monitor frames after that anchor
state:   Idle | RotatePending | Dumping | …
```

### Stored in RAM

- Last **snapshot** from `save_result` (response).
- **I/O replay events** after the anchor — whatever is required to replay the process **without the whole external ENV**:
  - `COPY` (+ `COPY_PAYLOAD`), `DATA`, `DRAIN`
  - plus `SAVE` (anchor markers in the stream)
  - `ERROR` as dump trigger (whether the error event itself is appended to the dump buffer is an implementation detail; dump is driven by the event)
  - `MANA` if external mana changes must be replayable (include if needed for fidelity)

### Not in RAM

- Logs / spans / metrics — **forwarded to debug-store immediately**; no rotation; not part of the death window.

### Byte threshold (relative to last stored snapshot)

- Limit is **bytes only** (event count irrelevant).
- Threshold ≈ **k × size of the current anchored snapshot** (e.g. 1× or 2×), using the **last installed** `memory.size()`.
- After `memory.grow`, the **next** `save` yields a larger snapshot → threshold grows with it.
- Rationale: if the event log is much larger than a fresh snapshot, it is cheaper to take a new snapshot and drop events than to keep a huge dump window.
- Rough bound: on the order of **~3×** recorded process memory (current snapshot + event buffer up to ~k× snapshot), not unbounded growth.

---

## Snapshot / event pairing and rotation

- `save` → `save_result` (RPC) **and** `process_save_event { snapshot_uid }` on the monitor FIFO (`SAVE` flag).
- `save` awaits monitor delivery (backpressure). Target I/O is accordingly stalled while save cannot complete — a second threshold hit during pending save is unlikely; if it happens, queue another `save`.
- **Cut rule:** install new anchor only when **both** are present for the same `snapshot_uid` (response and event may arrive in either order). Then drop buffered events **before** that `process_save_event`; keep events after it.
- Until both halves exist, keep the **previous** complete window (required for dump-during-rotation).

| State | Meaning |
|-------|---------|
| `Idle` | Complete anchor; appending I/O; may rotate on byte threshold |
| `RotatePending` | New save in flight / partially observed; still append against previous anchor |
| `Dumping` | Persist window to debug-store |

**Dump during `RotatePending`:** dump the **previous** complete snapshot + its events.

**API:**

- `dump` / checkpoint — persist current complete window **without** changing the window.
- Separate API to **force rotate** (`save` + cut).
- `dump_and_rotate` — optional convenience; **not needed for v1**.

---

## Dump triggers

Configurable at start:

- Dump on **`process_error_event`** (typical post-mortem default).
- **`process_killed_event` does not** dump by itself.
- Dump only via **recorder API** (configurable).

### Dump contents

Full window: current anchor snapshot + **all** buffered I/O since that anchor.  
**No `save` at dump time.**

### After error dump

Target is dead for recording purposes. No new empty window required. Leave monitor/session until **stop recording** so in-flight logs can still be forwarded.

### Persist format → debug-store

Prefer whatever is **simpler to implement and faster to write** (write path ≫ read/replay path for now). Opaque batched `debug_io_event` payloads vs 1:1 kernel message types — choose at implementation time for encoder cost / throughput.

---

## Monitor flags (v1)

Subscribe / handle for the replay window:

- `COPY` | `COPY_PAYLOAD` | `DATA` | `DRAIN` | `SAVE` | `ERROR`
- `MANA` if required for replay fidelity

Do **not** rely on:

- `INITIAL_BUFFER_STATE` / `INITIAL_BUFFER_DATA`
- `BUFFER_STATE` / `BUFFER_DATA` (viz-only; replay uses save + Copy/Data/Drain)

Exact flags remain a start-recording parameter.

---

## Backpressure

- Kernel already blocks pump / awaits `save` delivery when monitor buffers are full.
- Recorder **may** slow the target by draining slowly — acceptable for debugging.
- No silent drop of I/O events.

---

## debug-store usage

- On start: `begin` → bind session; keep open until **stop recording**.
- Continuously: forward logs/spans/metrics on the per-target session.
- On dump: write snapshot + I/O window; `sync`. Do **not** seal/fail the store session on error dump alone — session stays open until stop (late logs).
- On stop: flush, then `seal` / `fail` as appropriate.

---

## Prerequisites before coding recorder

1. **kernel-shield**: `monitor(…, monitor_config)` end-to-end (API, `kernel_rpc` client, spawn auto-monitor defaults).
2. **kernel-shield**: `save` → full **`save_result`** (not bare `binary`).
3. Freeze recorder RPC: start / stop / dump / force-rotate; per-target monitor + log sockets.
4. Multi-target limits (max targets / max window bytes) if needed for safety.

---

## Out of scope (for now)

- N previous snapshots (future).
- `dump_and_rotate` convenience API.
- Replay tooling / UI.
- Native (non-WASM) recorder port (same contract later).

---

## Closed decisions (changelog)

| Topic | Decision |
|-------|----------|
| Threshold | Relative to **last installed** snapshot byte size; updates after each save |
| I/O event set | COPY(+payload)/DATA/DRAIN (+ SAVE markers; MANA if needed); not whole ENV |
| Dump encode | Optimize for **write** simplicity/speed into debug-store |
| Store session lifetime | Until **stop recording** (catch queued logs after error) |
| Log ingress | **Socket per target** |
| Who monitors | **Recorder** calls `monitor` |
| INITIAL/BUFFER_* | Ignored; covered by snapshot memory |
| dump_and_rotate | Not in v1 |
| Shield monitor_config / save_result | Incomplete vs kernel — fix first |
