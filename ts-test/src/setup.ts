import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import fsp from 'node:fs/promises'

import { Kernel, ModuleProcess, LocalProcess, Direction } from '@wa-os/ts-kernel'
import {
  SocketRpcClient,
  SocketRpcServer,
  CodecRegistry,
  registerDynamicCodecs,
  deserializeTypeRegistry,
  ensureRpcCodecs,
  ensureRpcTypesInRegistry,
  TypeKind,
  TypeRegistry,
  TypeDescription,
  type SocketOptions,
  type LocalSocket,
  type TypeRegistry as TR,
} from '@wa-os/ts-rpc'
import {
  createGeneratedTypeRegistry,
  direction,
  monitor_flag,
  type save_result,
} from '@wa-os/ts-kernel/src/kernelApi.js'
import { createFsProcess, type FsProcessHandle } from '@wa-os/ts-fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const SOCKET_OPTS: SocketOptions = {
  inputBufferSize: 65536,
  outputBufferSize: 65536,
  flushThreshold: 4096,
  dataEventThreshold: 0,
  drainEventThreshold: 4,
  flags: 0,
}

export const CLIENT_ID = 0
export const SHIELD_ID = 1
export const STORE_ID = 2
export const RECORDER_ID = 3
export const FS_ID = 4
export const TARGET_ID = 5

export interface MockKernelCall {
  method: string
  args: any[]
  result?: any
  error?: Error
}

export interface TestContext {
  kernel: Kernel
  rootDir: string
  fsHandle: FsProcessHandle
  shield: ModuleProcess
  store: ModuleProcess
  recorder: ModuleProcess
  client: LocalProcess
  target: LocalProcess
  userClient: SocketRpcClient
  userRegistry: TypeRegistry
  userSocket: LocalSocket
  kernelCalls: MockKernelCall[]
  methodId: (name: string) => number
  cleanup: () => Promise<void>
}

/** Like TestContext but target is a real WASM ModuleProcess (mock-module echo). */
export interface WasmTargetTestContext {
  kernel: Kernel
  rootDir: string
  fsHandle: FsProcessHandle
  shield: ModuleProcess
  store: ModuleProcess
  recorder: ModuleProcess
  client: LocalProcess
  target: ModuleProcess
  userClient: SocketRpcClient
  userRegistry: TypeRegistry
  userSocket: LocalSocket
  targetClient: SocketRpcClient
  targetRegistry: TypeRegistry
  kernelCalls: MockKernelCall[]
  methodId: (name: string) => number
  echoMethodId: number
  echo: (payload: Uint8Array) => Promise<Uint8Array>
  cleanup: () => Promise<void>
}

function ensureProcessSlot(kernel: Kernel, id: number, process: any) {
  while (kernel.processes.length <= id) {
    kernel.processes.push(null)
  }
  kernel.processes[id] = process
}

function installKernelMock(
  kernel: Kernel,
  kernelTypes: Record<string, any>,
  kernelCalls: MockKernelCall[]
) {
  kernelTypes['kernel_spawn'].implementation = async (
    code: Uint8Array,
    memory_limit: number,
    mana_limit: number
  ) => {
    const call: MockKernelCall = { method: 'kernel.spawn', args: [code, memory_limit, mana_limit] }
    kernelCalls.push(call)
    const processId = await kernel.spawnLocal(mana_limit)
    call.result = processId
    return processId
  }

  kernelTypes['kernel_save'].implementation = async (id: number): Promise<save_result> => {
    const call: MockKernelCall = { method: 'kernel.save', args: [id] }
    kernelCalls.push(call)
    try {
      const result = await kernel.save(id)
      call.result = result
      return result
    } catch (error) {
      call.error = error instanceof Error ? error : new Error(String(error))
      throw error
    }
  }

  kernelTypes['kernel_kill'].implementation = async (id: number, error?: string) => {
    const call: MockKernelCall = { method: 'kernel.kill', args: [id, error] }
    kernelCalls.push(call)
    await kernel.kill(id, error)
  }

  kernelTypes['kernel_bind'].implementation = async (
    process_from: number,
    socket_from: number,
    process_to: number,
    socket_to: number,
    bindDirection: direction
  ) => {
    const call: MockKernelCall = {
      method: 'kernel.bind',
      args: [process_from, socket_from, process_to, socket_to, bindDirection],
    }
    kernelCalls.push(call)
    await kernel.bind(process_from, socket_from, process_to, socket_to, bindDirection as any)
  }

  kernelTypes['kernel_unbind'].implementation = async (
    process_from: number,
    socket_from: number,
    process_to: number,
    socket_to: number,
    unbindDirection: direction
  ) => {
    const call: MockKernelCall = {
      method: 'kernel.unbind',
      args: [process_from, socket_from, process_to, socket_to, unbindDirection],
    }
    kernelCalls.push(call)
    await kernel.unbind(process_from, socket_from, process_to, socket_to, unbindDirection as any)
  }

  kernelTypes['kernel_monitor'].implementation = async (
    target: number,
    monitor: number,
    monitor_socket: number,
    config: { flags: number }
  ) => {
    const call: MockKernelCall = {
      method: 'kernel.monitor',
      args: [target, monitor, monitor_socket, config],
    }
    kernelCalls.push(call)
    await kernel.monitor(target, monitor, monitor_socket, config)
  }

  kernelTypes['kernel_demonitor'].implementation = async (
    target: number,
    monitor: number,
    monitor_socket: number
  ) => {
    const call: MockKernelCall = {
      method: 'kernel.demonitor',
      args: [target, monitor, monitor_socket],
    }
    kernelCalls.push(call)
    await kernel.demonitor(target, monitor, monitor_socket)
  }

  kernelTypes['kernel_measure_mana'].implementation = async (process: number, new_mana: number) => {
    return kernel.measure_mana(process, new_mana)
  }

  kernelTypes['kernel_set_mana_limit'].implementation = async (process: number, mana_limit: number) => {
    await kernel.set_mana_limit(process, mana_limit)
  }

  kernelTypes['kernel_list_socket_bindings'].implementation = async (
    process: number
  ): Promise<unknown> => {
    const call: MockKernelCall = {
      method: 'kernel.list_socket_bindings',
      args: [process],
    }
    kernelCalls.push(call)
    try {
      const result = await kernel.list_socket_bindings(process)
      call.result = result
      return result
    } catch (error) {
      call.error = error instanceof Error ? error : new Error(String(error))
      throw error
    }
  }

  kernelTypes['kernel_get_rpc_description'].implementation = async (
    process: number,
    socket: number
  ): Promise<Uint8Array> => {
    const call: MockKernelCall = {
      method: 'kernel.get_rpc_description',
      args: [process, socket],
    }
    kernelCalls.push(call)
    try {
      const result = await kernel.get_rpc_description(process, socket)
      call.result = result
      return result
    } catch (error) {
      call.error = error instanceof Error ? error : new Error(String(error))
      throw error
    }
  }

  kernelTypes['kernel_resurect'].implementation = async (
    code: Uint8Array,
    memory: Uint8Array,
    memory_limit: number,
    mana_limit: number
  ) => {
    return kernel.resurect(code, memory, memory_limit, mana_limit)
  }
}

export async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fsp.mkdtemp(join(os.tmpdir(), 'waos-recorder-'))
  try {
    return await fn(root)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
}

export async function setupTestEnvironment(rootDir: string): Promise<TestContext> {
  const kernel = new Kernel()
  const kernelCalls: MockKernelCall[] = []

  const shieldCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/kernel-shield.wasm'))
  const storeCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/debug-store.wasm'))
  const recorderCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/recorder.wasm'))

  const shield = new ModuleProcess(kernel, SHIELD_ID, 2048, 5_000_000)
  await shield.setModuleCode(shieldCode)
  await shield.start()
  ensureProcessSlot(kernel, SHIELD_ID, shield)

  const store = new ModuleProcess(kernel, STORE_ID, 2048, 5_000_000)
  await store.setModuleCode(storeCode)
  await store.start()
  ensureProcessSlot(kernel, STORE_ID, store)

  const fsHandle = createFsProcess(kernel, {
    rootDir,
    processId: FS_ID,
    socketId: 0,
    socketOptions: SOCKET_OPTS,
  })
  fsHandle.process.bind(store, 0, 1, Direction.BOTH)

  const client = new LocalProcess(kernel, CLIENT_ID, 1_000_000)
  ensureProcessSlot(kernel, CLIENT_ID, client)

  const target = new LocalProcess(kernel, TARGET_ID, 1_000_000)
  target.memory = new Uint8Array(64).fill(7)
  ensureProcessSlot(kernel, TARGET_ID, target)

  // Start recorder before shield register so initialize()/monitor finds it
  const recorder = new ModuleProcess(kernel, RECORDER_ID, 2048, 5_000_000)
  await recorder.setModuleCode(recorderCode)
  await recorder.start()
  ensureProcessSlot(kernel, RECORDER_ID, recorder)

  // Client sockets: 1=shield KERNEL mock, 3=shield MONITOR, 10=temp shield USER for register
  client.createSocket(1, SOCKET_OPTS)
  client.createSocket(3, SOCKET_OPTS)
  client.bind(shield, 1, 1, Direction.BOTH)
  client.bind(shield, 3, 3, Direction.BOTH)

  // Kernel mock on client socket 1
  const { registry: kernelRegistry, types: kernelTypes } = createGeneratedTypeRegistry()
  installKernelMock(kernel, kernelTypes, kernelCalls)
  kernelRegistry.assignMethodIds()
  const kernelCodecs = new CodecRegistry()
  registerDynamicCodecs(kernelCodecs, kernelRegistry)
  ensureRpcCodecs(kernelCodecs, kernelRegistry)
  const kernelSocket = client.getSocket(1) as LocalSocket
  client.setRpcDescription(1, kernelRegistry)
  new SocketRpcServer(kernelSocket, kernelRegistry, kernelCodecs)

  // Register recorder + target + store with shield (temporary bind to USER)
  const shieldDesc = deserializeTypeRegistry(shield.readRawRpcDescription(0))
  shieldDesc.assignMethodIds()
  const shieldMethods = new Map(shieldDesc.getMethods().map((m) => [m.memberName, m.methodId]))
  const shieldSock = client.createSocket(10, SOCKET_OPTS)
  client.bind(shield, 10, 0, Direction.BOTH)
  client.setRpcDescription(10, shieldDesc)
  const shieldCodecs = new CodecRegistry()
  registerDynamicCodecs(shieldCodecs, shieldDesc)
  ensureRpcCodecs(shieldCodecs, shieldDesc)
  const shieldClient = new SocketRpcClient(shieldSock, shieldDesc, shieldCodecs)

  const registerId = shieldMethods.get('kernel_shield.register_process')
  if (registerId === undefined) throw new Error('missing register_process')
  await shieldClient.call(registerId, TARGET_ID, CLIENT_ID, false)
  await shieldClient.call(registerId, STORE_ID, CLIENT_ID, false)
  await shieldClient.call(registerId, RECORDER_ID, CLIENT_ID, false)

  // Free shield USER for recorder SHIELD socket
  client.unbind(shield, 10, 0, Direction.BOTH)
  recorder.bind(shield, 1, 0, Direction.BOTH)

  const userSocket = client.createSocket(0, SOCKET_OPTS)
  client.bind(recorder, 0, 0, Direction.BOTH)

  // Recorder USER client
  const userRegistry = deserializeTypeRegistry(recorder.readRawRpcDescription(0))
  userRegistry.assignMethodIds()
  client.setRpcDescription(0, userRegistry)
  const userCodecs = new CodecRegistry()
  registerDynamicCodecs(userCodecs, userRegistry)
  ensureRpcCodecs(userCodecs, userRegistry)
  const userClient = new SocketRpcClient(userSocket, userRegistry, userCodecs)

  const methods = new Map(userRegistry.getMethods().map((m) => [m.memberName, m.methodId]))
  const methodId = (name: string) => {
    const full = name.includes('.') ? name : `recorder.${name}`
    const id = methods.get(full)
    if (id === undefined) {
      throw new Error(`missing method ${full}; have: ${[...methods.keys()].join(', ')}`)
    }
    return id
  }

  return {
    kernel,
    rootDir,
    fsHandle,
    shield,
    store,
    recorder,
    client,
    target,
    userClient,
    userRegistry,
    userSocket,
    kernelCalls,
    methodId,
    cleanup: async () => {
      try { await recorder.kill(undefined) } catch { /* ignore */ }
      try { await store.kill(undefined) } catch { /* ignore */ }
      try { await shield.kill(undefined) } catch { /* ignore */ }
    },
  }
}

/**
 * Same topology as setupTestEnvironment, but TARGET is mock-module.wasm
 * (real RPC echo) instead of a LocalProcess stub.
 */
export async function setupWasmTargetEnvironment(rootDir: string): Promise<WasmTargetTestContext> {
  const kernel = new Kernel()
  const kernelCalls: MockKernelCall[] = []

  const shieldCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/kernel-shield.wasm'))
  const storeCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/debug-store.wasm'))
  const recorderCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/recorder.wasm'))
  const mockCode = await readFile(
    join(__dirname, '../../../cmake-build-emscripten/kernel-shield/cpp-test/mock-module.wasm')
  )

  const shield = new ModuleProcess(kernel, SHIELD_ID, 2048, 5_000_000)
  await shield.setModuleCode(shieldCode)
  await shield.start()
  ensureProcessSlot(kernel, SHIELD_ID, shield)

  const store = new ModuleProcess(kernel, STORE_ID, 2048, 5_000_000)
  await store.setModuleCode(storeCode)
  await store.start()
  ensureProcessSlot(kernel, STORE_ID, store)

  const fsHandle = createFsProcess(kernel, {
    rootDir,
    processId: FS_ID,
    socketId: 0,
    socketOptions: SOCKET_OPTS,
  })
  fsHandle.process.bind(store, 0, 1, Direction.BOTH)

  const client = new LocalProcess(kernel, CLIENT_ID, 1_000_000)
  ensureProcessSlot(kernel, CLIENT_ID, client)

  // initial == maximumMemoryPages in ModuleProcess; keep small so save/dump snapshots fit sockets.
  const target = new ModuleProcess(kernel, TARGET_ID, 16, 5_000_000)
  await target.setModuleCode(mockCode)
  await target.start()
  ensureProcessSlot(kernel, TARGET_ID, target)

  const recorder = new ModuleProcess(kernel, RECORDER_ID, 2048, 5_000_000)
  await recorder.setModuleCode(recorderCode)
  await recorder.start()
  ensureProcessSlot(kernel, RECORDER_ID, recorder)

  client.createSocket(1, SOCKET_OPTS)
  client.createSocket(3, SOCKET_OPTS)
  client.bind(shield, 1, 1, Direction.BOTH)
  client.bind(shield, 3, 3, Direction.BOTH)

  const { registry: kernelRegistry, types: kernelTypes } = createGeneratedTypeRegistry()
  installKernelMock(kernel, kernelTypes, kernelCalls)
  kernelRegistry.assignMethodIds()
  const kernelCodecs = new CodecRegistry()
  registerDynamicCodecs(kernelCodecs, kernelRegistry)
  ensureRpcCodecs(kernelCodecs, kernelRegistry)
  const kernelSocket = client.getSocket(1) as LocalSocket
  client.setRpcDescription(1, kernelRegistry)
  new SocketRpcServer(kernelSocket, kernelRegistry, kernelCodecs)

  const shieldDesc = deserializeTypeRegistry(shield.readRawRpcDescription(0))
  shieldDesc.assignMethodIds()
  const shieldMethods = new Map(shieldDesc.getMethods().map((m) => [m.memberName, m.methodId]))
  const shieldSock = client.createSocket(10, SOCKET_OPTS)
  client.bind(shield, 10, 0, Direction.BOTH)
  client.setRpcDescription(10, shieldDesc)
  const shieldCodecs = new CodecRegistry()
  registerDynamicCodecs(shieldCodecs, shieldDesc)
  ensureRpcCodecs(shieldCodecs, shieldDesc)
  const shieldClient = new SocketRpcClient(shieldSock, shieldDesc, shieldCodecs)

  const registerId = shieldMethods.get('kernel_shield.register_process')
  if (registerId === undefined) throw new Error('missing register_process')
  await shieldClient.call(registerId, TARGET_ID, CLIENT_ID, false)
  await shieldClient.call(registerId, STORE_ID, CLIENT_ID, false)
  await shieldClient.call(registerId, RECORDER_ID, CLIENT_ID, false)

  client.unbind(shield, 10, 0, Direction.BOTH)
  recorder.bind(shield, 1, 0, Direction.BOTH)

  const userSocket = client.createSocket(0, SOCKET_OPTS)
  client.bind(recorder, 0, 0, Direction.BOTH)

  const userRegistry = deserializeTypeRegistry(recorder.readRawRpcDescription(0))
  userRegistry.assignMethodIds()
  client.setRpcDescription(0, userRegistry)
  const userCodecs = new CodecRegistry()
  registerDynamicCodecs(userCodecs, userRegistry)
  ensureRpcCodecs(userCodecs, userRegistry)
  const userClient = new SocketRpcClient(userSocket, userRegistry, userCodecs)

  const methods = new Map(userRegistry.getMethods().map((m) => [m.memberName, m.methodId]))
  const methodId = (name: string) => {
    const full = name.includes('.') ? name : `recorder.${name}`
    const id = methods.get(full)
    if (id === undefined) {
      throw new Error(`missing method ${full}; have: ${[...methods.keys()].join(', ')}`)
    }
    return id
  }

  // Client ↔ mock-module USER (socket 0). Registry is built on the host — mock-module's
  // rpc_description re-runs register_all and throws under wasm-exceptions.
  const targetSock = client.createSocket(20, SOCKET_OPTS)
  client.bind(target, 20, 0, Direction.BOTH)

  const targetRegistry = new TypeRegistry()
  const binaryType = targetRegistry.getTypeByName('binary')
  if (!binaryType) throw new Error('TypeRegistry missing binary')
  const echoFunc = TypeDescription.create({
    name: 'mock_api.echo',
    kind: TypeKind.Function,
    members: [{ name: 'data', type: binaryType, annotations: [] }],
    item: binaryType,
  })
  const echoApi = TypeDescription.create({
    name: 'mock_api',
    kind: TypeKind.Object,
    members: [{ name: 'echo', type: echoFunc, annotations: [] }],
  })
  targetRegistry.registerType(echoFunc)
  targetRegistry.registerType(echoApi)
  targetRegistry.assignMethodIds()
  ensureRpcTypesInRegistry(targetRegistry)
  client.setRpcDescription(20, targetRegistry)
  const targetCodecs = new CodecRegistry()
  registerDynamicCodecs(targetCodecs, targetRegistry)
  ensureRpcCodecs(targetCodecs, targetRegistry)
  const targetClient = new SocketRpcClient(targetSock, targetRegistry, targetCodecs)

  const echoMethod = targetRegistry.getMethods().find(
    (m) => m.memberName === 'echo' || m.memberName === 'mock_api.echo'
  )
  if (!echoMethod) {
    throw new Error(
      `echo method missing; have: ${targetRegistry.getMethods().map((m) => m.memberName).join(', ')}`
    )
  }
  const echoMethodId = echoMethod.methodId

  const echo = async (payload: Uint8Array): Promise<Uint8Array> => {
    const result = await targetClient.call(echoMethodId, payload)
    if (result instanceof Uint8Array) return result
    if (result instanceof ArrayBuffer) return new Uint8Array(result)
    throw new Error(`echo returned unexpected type: ${typeof result}`)
  }

  return {
    kernel,
    rootDir,
    fsHandle,
    shield,
    store,
    recorder,
    client,
    target,
    userClient,
    userRegistry,
    userSocket,
    targetClient,
    targetRegistry,
    kernelCalls,
    methodId,
    echoMethodId,
    echo,
    cleanup: async () => {
      try { await target.kill(undefined) } catch { /* ignore */ }
      try { await recorder.kill(undefined) } catch { /* ignore */ }
      try { await store.kill(undefined) } catch { /* ignore */ }
      try { await shield.kill(undefined) } catch { /* ignore */ }
    },
  }
}

export function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v)
  return Number(v)
}

export async function tick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

export function emitCopy(
  ctx: TestContext,
  amount: number,
  payload?: Uint8Array
): void {
  const monitors = ctx.target.monitors
  if (!monitors.length) {
    throw new Error('target has no monitors')
  }
  for (const mon of monitors) {
    if (mon.process.id !== RECORDER_ID) continue
    ctx.kernel.monitorEmitter.deliverEvent(
      mon,
      'process_copy_event',
      {
        _type: 'process_copy_event',
        process: TARGET_ID,
        socket: 0,
        direction: direction.OUT,
        amount,
      },
      payload
    )
  }
}

export function emitBind(
  ctx: TestContext,
  peerProcess: number,
  peerSocket = 0,
  localSocket = 0
): void {
  for (const mon of ctx.target.monitors) {
    if (mon.process.id !== RECORDER_ID) continue
    ctx.kernel.monitorEmitter.deliverEvent(mon, 'process_bind_event', {
      _type: 'process_bind_event',
      process: TARGET_ID,
      socket: localSocket,
      peer_process: peerProcess,
      peer_socket: peerSocket,
      direction: direction.BOTH,
    })
  }
}

export function emitError(ctx: TestContext, message = 'boom'): void {
  ctx.kernel.monitorEmitter.emitLifecycleEvent(ctx.target, 'process_error_event', {
    _type: 'process_error_event',
    process: TARGET_ID,
    error: message,
  })
}

export function emitMana(ctx: TestContext): void {
  for (const mon of ctx.target.monitors) {
    if (mon.process.id !== RECORDER_ID) continue
    ctx.kernel.monitorEmitter.deliverEvent(mon, 'process_measure_mana_event', {
      _type: 'process_measure_mana_event',
      process: TARGET_ID,
      new_mana: 42,
    })
  }
}

export { monitor_flag }
