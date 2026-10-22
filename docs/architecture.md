# Architecture

The contract header is
[rpc-cpp](https://github.com/daemonarium/rpc-cpp) `v0.1.0`,
`src/examples/structures/recorder.hpp`. USER, monitor, and log
channels use flat message framing (`flat_socket_rpc_*`).

The recorder process id is 3 (`g_own_process_id`). The host places
this module at that id. A typical table is client 0, kernel-shield 1,
debug-store 2, recorder 3, filesystem 4, target 5.

```
Client
    │  socket 0
    ▼
recorder.wasm  ── socket 1 ──► kernel-shield.wasm ──► kernel
    │
    └── begin and session ──► debug-store.wasm ──► @daemonarium/fs
```

## record_config

- `event_buffer_snapshot_mult` is 1 or 2. Anything else is `recorder_invalid_argument`. The rotate threshold is that multiplier times the current snapshot size.
- `record_mana` includes mana monitor frames when true.
- `dump_on_error` writes the current window on `process_error_event` and does not seal the store.

## Window calls

- `dump` persists the current snapshot and appends `io.bin`. The RAM window stays.
- `dump_and_clear` persists, then clears `io_bytes`. It does not take a new save.
- `rotate` requests the next save and cuts the window only when both the new memory and the matching `process_save_event` exist.

`start_recording` returns `recording_id`, `monitor_socket`, `log_socket`, `store_session_id`, and `store_socket`. An empty `code` is enough for a `LocalProcess` target. Non-empty `code` is written to the store as `code.wasm` and then dropped from RAM.

## Shield method ids

`src/shield_client.hpp` calls kernel-shield `v0.1.0` by declaration order:

- `register_process` 4
- `save` 6
- `bind` 8
- `unbind` 9
- `monitor` 10
- `demonitor` 11
- `list_socket_bindings` 14
- `get_rpc_description` 15

## Store method ids

`src/store_client.hpp` calls debug-store `v0.1.0`:

- `debug_store.begin` 0
- session `sync` 1, `seal` 2, `fail` 3

`set_labels` is id 0 on the session and is not called. Do not renumber either header.

## .waosrec

`waosrec pack` reads one debug-store session directory and writes one file. The blob, from `src/waosrec.hpp`, holds:

- a manifest (`format_version`, `session_meta`, the highest-uid `snapshot_meta`)
- `code`
- `memory`
- `events`
- `bindings`
- one registry blob per `registry.<pid>.<sock>.bin`

`waosrec info` prints that manifest. The packer does not open a kernel.
