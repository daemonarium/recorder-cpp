# recorder

A WebAssembly module that records processes into an in-RAM window
and writes the session through debug-store. The native `waosrec`
tool packs that session directory into one `.waosrec` file.

This repository is `daemonarium/recorder-cpp`. The artifacts are
`recorder.wasm` and `waosrec`. It is not an npm package.

## Why it is a separate module

The kernel only emits monitor events and `save`. `kernel-shield` is
the capability boundary: monitor, save, and bind. `debug-store` only
writes bytes. Rotation, dump-on-error, and live log forwarding live
here, so a later Wasm VM loads the same file.

`module-debugger` reads `.waosrec`. It is not in this repo.

## Build

Stock Clang cannot compile this module or the packer. Build the
[reflection-toolchain](https://github.com/daemonarium/reflection-toolchain)
sysroot and point `P2996_COMPILER_SYSROOT` at it.

This module compiles sources from
[rpc-cpp](https://github.com/daemonarium/rpc-cpp) `v0.1.0`:

```
git submodule add https://github.com/daemonarium/rpc-cpp.git extern/rpc-cpp
cd extern/rpc-cpp && git checkout v0.1.0
```

Wasm:

```
cmake -B build-web -S . \
  -DCMAKE_TOOLCHAIN_FILE=$P2996_COMPILER_SYSROOT/toolchain/emscripten-p2996-toolchain.cmake \
  -DWASM=ON
cmake --build build-web --target recorder-wasm
```

`build-web/recorder.wasm` exports `_rpc_description`, `_start`,
`_malloc`, `_waos_socket_data`, and `_waos_socket_output_drain`.

Native packer, with the reflection toolchain rather than Emscripten:

```
cmake -B build -S . \
  -DCMAKE_TOOLCHAIN_FILE=$P2996_COMPILER_SYSROOT/toolchain/p2996-toolchain.cmake
cmake --build build --target waosrec
```

`kernel-shield.wasm`, `debug-store.wasm`, and `mock-module.wasm`
come from
[kernel-shield-cpp](https://github.com/daemonarium/kernel-shield-cpp)
and
[debug-store-cpp](https://github.com/daemonarium/debug-store-cpp)
at `v0.1.0`. They are not linked into this module.

## How a host runs it

The recorder's process id is 3. `@daemonarium/kernel` loads the three
wasm modules. Bind recorder socket 1 to kernel-shield socket 0 before
`start_recording`. Bind the `@daemonarium/fs` socket to debug-store
socket 1 before the first session.

See [docs/examples.md](docs/examples.md).

```
waosrec pack sessions/1 -o session.waosrec
waosrec info session.waosrec
```

## Sockets and the window

| Socket | Role |
|--------|------|
| 0 | User API. `start_recording`, `stop_recording`, `dump`, `dump_and_clear`, `rotate`. |
| 1 | Outbound to kernel-shield socket 0. |
| 2 and up | Per-target monitor, log ingress, and the debug-store session. |

`dump` leaves the window in place. `dump_and_clear` clears
`io_bytes`. `rotate` cuts a new snapshot. `event_buffer_snapshot_mult`
is 1 or 2.

The contract, method ids, and `.waosrec` layout are in
[docs/architecture.md](docs/architecture.md). The design note is
[DESIGN.md](DESIGN.md).

## License

MIT. Upstream notices are in `NOTICE`. Conduct is in
`CODE_OF_CONDUCT.md`.
