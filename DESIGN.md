# Recorder (WASM) — design notes

Status: **implemented** (see [`README.md`](./README.md)).  
Sibling: [debug-store-cpp](https://github.com/daemonarium/debug-store-cpp) (persistence sink).  
Kernel model: [kernel-ts](https://github.com/daemonarium/kernel-ts) — process recording and replay.  
Capability boundary: [kernel-shield-cpp](https://github.com/daemonarium/kernel-shield-cpp).

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
                    USER RPC (start/stop/dump/dump_and_clear/rotate)
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
- `BIND` / `UNBIND` (`process_bind_event` / `process_unbind_event`) — count toward rotate threshold
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

**API:**

| RPC | Effect |
|-----|--------|
| `dump` | Persist current window; **`io_bytes` unchanged** |
| `dump_and_clear` | Same persist as `dump`, then **clear `io_bytes`** (no new save/anchor) |
| `rotate` | Force save + cut (new anchor; drop I/O up to cut) |
| `dump_and_rotate` | **Not in v1** (dump + rotate as one op) |

`dump_and_clear` ≠ `rotate`: clear drops the I/O window only; rotate installs a new memory snapshot cut.

---

## Dump → debug-store (write-optimized)

1. `debug_snapshot_event {uid, mana_*}` + trailing = `anchor.memory`
2. One (or chunked) `debug_io_event` + trailing = **opaque** concatenation of raw monitor frames in `io_bytes` — **no** re-parse/re-encode of Copy/Data/Drain
3. `debug_session.sync`
4. Window unchanged for `dump`; cleared after step 3 for `dump_and_clear`

Seal/fail store only on **`stop_recording`**.

---

## Topology capture

After the **first complete save anchor** in `start_recording`:

1. `list_socket_bindings(target)` via shield → `debug_bindings_event` + serialized `bindings_snapshot` (`bindings.bin`)
2. If `start_recording_request.code` is non-empty → `debug_code_event` + bytes → `code.wasm`, then clear the in-RAM copy
3. Soft-fetch `get_rpc_description(target, 0)` → `registry.<target>.0.bin` (empty on soft-fail; kernel uses non-killing `readRawRpcDescriptionOrEmpty`)
4. For other **local** target sockets (client ends such as KERNEL_API): write empty registry placeholders (no public object API)
5. For each **peer** `(peer_process, peer_socket)`: `get_rpc_description` → `debug_registry_event` (empty on soft-fail). **kernel-shield (pid 1)** answers its own sockets locally (USER / KERNEL_API faces) without being in the shield `processes` table
6. `debug_session.sync` so files are durable before start returns

Mid-session:

- `process_bind_event` / `process_unbind_event`: append opaque frame to `io_bytes_` (rotate-eligible)
- On **bind**: queue `get_rpc_description(peer, peer_sock)` after monitor `handle_data` (must not nest shield RPCs) → `debug_registry_event`. Unbind does not delete registry files.

---

## Monitor flags (v1)

Always: `COPY | COPY_PAYLOAD | DATA | DRAIN | SAVE | ERROR | BIND`  
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
| dump_and_clear | In API: dump then clear `io_bytes` (no new snap) |
| dump_and_rotate | Not in v1 |
| Shield API | Synced: `monitor_config` + `save_result` |
| Topology | After first anchor: bindings + registries to store; BIND frames opaque; mid-session bind refreshes peer registry |

