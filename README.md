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

Requires [`kernel-shield`](../kernel-shield/) and [`debug-store`](../debug-store/) for the intended topology.

## Topology

| Socket | Role |
|--------|------|
| 0 | USER — `recorder` RPC (`start_recording`, `stop_recording`, `dump`, `rotate`) |
| 1 | SHIELD — outbound to kernel-shield USER |
| ≥2 | per-target monitor, log ingress, store USER (temp), store session |

Host must bind `recorder.1 ↔ kernel-shield.0` before use. On `start_recording`, the module binds to debug-store via `shield.bind`, calls `begin`, then monitors/saves the target through shield.

`g_own_process_id` defaults to `3` (must match the recorder pid in the kernel).

## Tests

```bash
# build required WASMs first (mock-module = e2e echo target)
cmake --build cmake-build-emscripten --target mock-module recorder-wasm kernel-shield debug-store
npm install
npm test -w @wa-os/recorder-tests
```

Harness: Kernel + kernel-shield + mock kernel RPC + debug-store + ts-fs + recorder.

- Synthetic scenarios (`recorder.test.ts`): invalid `k`, start, dump, rotate, dump-on-error, `record_mana=false` (LocalProcess stub + injected monitor frames).
- E2E (`recorder.e2e.test.ts`): real [`mock-module.wasm`](../kernel-shield/cpp-test/src/mock_module.cpp) echo traffic → `kernel.kill(..., error)` → assert `sessions/<id>/{meta.json,snap.*.bin,snap.*.meta.json,io.bin}` on disk (no replay).

## RPC contract

Types: [`cpp-rpc/src/examples/structures/recorder.hpp`](../cpp-rpc/src/examples/structures/recorder.hpp)

`record_config.event_buffer_snapshot_mult` must be `1` or `2`.
