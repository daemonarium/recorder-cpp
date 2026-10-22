# Example

The host chooses `rootDir` and supplies the three wasm files. The
recorder process id is 3. Empty `code` is enough when the target is a
`LocalProcess`.

```ts
import { readFile } from 'node:fs/promises'
import { Kernel, ModuleProcess, LocalProcess, Direction } from '@daemonarium/kernel'
import {
  CodecRegistry,
  SocketRpcClient,
  deserializeTypeRegistry,
  ensureRpcCodecs,
  registerDynamicCodecs,
} from '@daemonarium/rpc'
import { createFsProcess } from '@daemonarium/fs'

const socketOptions = {
  inputBufferSize: 65536,
  outputBufferSize: 65536,
  flushThreshold: 4096,
  dataEventThreshold: 0,
  drainEventThreshold: 4,
  flags: 0,
}

const kernel = new Kernel()
const fs = createFsProcess(kernel, {
  rootDir: './data',
  processId: 4,
  socketId: 0,
  socketOptions,
})

async function loadModule(path: string, id: number, mana = 1_000_000) {
  const proc = new ModuleProcess(kernel, id, 2048, mana)
  await proc.setModuleCode(await readFile(path))
  await proc.start()
  while (kernel.processes.length <= id) kernel.processes.push(null)
  kernel.processes[id] = proc
  return proc
}

const shield = await loadModule('extern/kernel-shield-cpp/build-web/kernel-shield.wasm', 1)
const store = await loadModule('extern/debug-store-cpp/build-web/debug-store.wasm', 2)
const recorder = await loadModule('build-web/recorder.wasm', 3, 5_000_000)

// debug-store socket 1 ↔ fs socket 0, before the first session
fs.process.bind(store, 0, 1, Direction.BOTH)
// recorder socket 1 ↔ kernel-shield socket 0, before start_recording
recorder.bind(shield, 1, 0, Direction.BOTH)

const client = new LocalProcess(kernel, 0, 1_000_000)
kernel.processes[0] = client
const userSocket = client.createSocket(0, socketOptions)
client.bind(recorder, 0, 0, Direction.BOTH)

const registry = deserializeTypeRegistry(recorder.readRawRpcDescription(0))
registry.assignMethodIds()
client.setRpcDescription(0, registry)
const codecs = new CodecRegistry()
registerDynamicCodecs(codecs, registry)
ensureRpcCodecs(codecs, registry)
const rpc = new SocketRpcClient(userSocket, registry, codecs)

const start = registry.getMethods().find((m) => m.memberName === 'recorder.start_recording')
const recording = await rpc.call(start!.methodId, {
  target_process: 5n,
  store_process: 2n,
  session_name: 'run-1',
  labels: { env: 'dev' },
  config: {
    event_buffer_snapshot_mult: 1,
    record_mana: false,
    dump_on_error: true,
  },
  code: new Uint8Array(),
})
```

`./data/sessions/1/` is the session on the host. `waosrec pack` turns
that directory into one `.waosrec` file. The shield still needs its
own socket 1 bound to the kernel RPC; that bind is the kernel-shield
contract, not a recorder socket.
