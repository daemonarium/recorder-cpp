# recorder

WASM module: multi-target process recording (in-RAM I/O window + snapshot rotation) with live log/span/metric forward to [`debug-store`](../debug-store/).

**Design:** [`DESIGN.md`](./DESIGN.md)

## Build

From the repo root (Emscripten / `WASM=ON` tree, same as other modules):

```bash
cmake -S . -B cmake-build-emscripten -DWASM=ON
cmake --build cmake-build-emscripten --target recorder-wasm
# outputs cmake-build-emscripten/recorder.wasm
```

Native packer CLI (non-WASM build):

```bash
cmake -S . -B cmake-build-debug
cmake --build cmake-build-debug --target waosrec   # or build/ if that’s your tree
# waosrec pack <session-dir> -o out.waosrec
# waosrec info out.waosrec
```

Requires [`kernel-shield`](../kernel-shield/) and [`debug-store`](../debug-store/) for the intended topology.

## Topology

| Socket | Role |
|--------|------|
| 0 | USER — `recorder` RPC (`start_recording`, `stop_recording`, `dump`, `dump_and_clear`, `rotate`) |
| 1 | SHIELD — outbound to kernel-shield USER |
| ≥2 | per-target monitor, log ingress, store USER (temp), store session |

Host must bind `recorder.1 ↔ kernel-shield.0` before use. On `start_recording`, the module binds to debug-store via `shield.bind`, calls `begin`, then monitors/saves the target through shield. USER RPC and monitor/log channels use **flat** (`flat_socket_rpc_*` / flat message framing). Pass target WASM bytes in `start_recording.code` (empty OK for LocalProcess); recorder dumps them to store as `code.wasm` and clears the session copy. Fixture harnesses prefer **`dump_and_clear`** over bare `dump` when `dump_on_error` may still fire.

| RPC | Window after persist |
|-----|----------------------|
| `dump` | unchanged (snapshot; store appends `io.bin`) |
| `dump_and_clear` | `io_bytes` cleared (no new save/anchor) |
| `rotate` | cut to new snap (see [DESIGN.md](./DESIGN.md)) |

`g_own_process_id` defaults to `3` (must match the recorder pid in the kernel).

## Tests

```bash
# build required WASMs first (mock-module = e2e echo target)
cmake --build cmake-build-emscripten --target mock-module recorder-wasm kernel-shield debug-store
cmake --build cmake-build-debug --target waosrec   # for e2e pack round-trip; or build/
npm install
npm test -w @wa-os/recorder-tests
```

Harness: Kernel + kernel-shield + mock kernel RPC + debug-store + ts-fs + recorder.

- Synthetic scenarios (`recorder.test.ts`): invalid `k`, start, code dump, dump / dump-twice / `dump_and_clear`, rotate, dump-on-error, `record_mana=false` (LocalProcess stub + injected monitor frames).
- E2E (`recorder.e2e.test.ts`): real [`mock-module.wasm`](../kernel-shield/cpp-test/src/mock_module.cpp) bytes in `start_recording.code` → echo traffic → `kernel.kill(..., error)` → assert `sessions/<id>/{meta.bin,code.wasm,bindings.bin,snap.*.bin,snap.*.meta.bin,io.bin}` and `waosrec pack` round-trip.

Full stack gate (from repo root): see [`TESTING.md`](../TESTING.md) (`npm run gate`).

## RPC contract

Types: [`cpp-rpc/src/examples/structures/recorder.hpp`](../cpp-rpc/src/examples/structures/recorder.hpp)

`record_config.event_buffer_snapshot_mult` must be `1` or `2`.

`.waosrec` format: [`src/waosrec.hpp`](./src/waosrec.hpp).
