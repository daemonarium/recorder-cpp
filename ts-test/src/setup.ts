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
  deserializeTypedJson,
  ensureRpcCodecs,
  ensureRpcTypesInRegistry,
  LocalCircularBuffer,
  LocalCircularBufferReader,
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

/** Large enough for start_recording.code carrying a full mock-module.wasm (~6MiB). */
export const LARGE_SOCKET_OPTS: SocketOptions = {
  inputBufferSize: 8 * 1024 * 1024,
  outputBufferSize: 8 * 1024 * 1024,
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
    // Real ModuleProcess + WASM (shield spawn must load module code, not LocalProcess).
    const processId = await kernel.spawn(code, memory_limit, mana_limit)
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

  const userSocket = client.createSocket(0, LARGE_SOCKET_OPTS)
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
 * Same topology as setupTestEnvironment, but TARGET is a real WASM ModuleProcess.
 * Defaults to mock-module.wasm + host-built echo registry.
 * Pass `targetWasmPath` / `buildTargetRegistry` for sample dbg_* modules.
 */
export async function setupWasmTargetEnvironment(
  rootDir: string,
  options?: {
    targetWasmPath?: string
    buildTargetRegistry?: () => TypeRegistry
  }
): Promise<WasmTargetTestContext> {
  const kernel = new Kernel()
  const kernelCalls: MockKernelCall[] = []

  const shieldCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/kernel-shield.wasm'))
  const storeCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/debug-store.wasm'))
  const recorderCode = await readFile(join(__dirname, '../../../cmake-build-emscripten/recorder.wasm'))
  const targetCode = await readFile(
    options?.targetWasmPath ??
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
  await target.setModuleCode(targetCode)
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

  const userSocket = client.createSocket(0, LARGE_SOCKET_OPTS)
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

  const targetSock = client.createSocket(20, SOCKET_OPTS)
  client.bind(target, 20, 0, Direction.BOTH)

  let targetRegistry: TypeRegistry
  if (options?.buildTargetRegistry) {
    targetRegistry = options.buildTargetRegistry()
  } else {
    // Default mock-module echo registry (host-built fallback).
    targetRegistry = new TypeRegistry()
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
  }
  try {
    const raw = target.readRawRpcDescriptionOrEmpty(0)
    if (raw && raw.length > 0) {
      const fromWasm = deserializeTypeRegistry(raw)
      fromWasm.assignMethodIds()
      targetRegistry = fromWasm
    }
  } catch {
    /* keep host/fallback registry */
  }

  client.setRpcDescription(20, targetRegistry)
  const targetCodecs = new CodecRegistry()
  registerDynamicCodecs(targetCodecs, targetRegistry)
  ensureRpcCodecs(targetCodecs, targetRegistry)
  const targetClient = new SocketRpcClient(targetSock, targetRegistry, targetCodecs)

  const echoMethod = targetRegistry.getMethods().find(
    (m) => m.memberName === 'echo' || m.memberName.endsWith('.echo')
  )
  const echoMethodId = echoMethod?.methodId ?? -1

  const echo = async (payload: Uint8Array): Promise<Uint8Array> => {
    if (echoMethodId < 0) throw new Error('echo method not available on this target')
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

/** Shared pieces for multi-module (token↔kv) recording fixtures. */
export interface TokenKvRecordingContext {
  kernel: Kernel
  rootDir: string
  fsHandle: FsProcessHandle
  shield: ModuleProcess
  store: ModuleProcess
  recorder: ModuleProcess
  client: LocalProcess
  /** Recorded process = dbg_token */
  target: ModuleProcess
  tokenPid: number
  kvPid: number
  kv: ModuleProcess
  userClient: SocketRpcClient
  userRegistry: TypeRegistry
  userSocket: LocalSocket
  targetClient: SocketRpcClient
  targetRegistry: TypeRegistry
  /** Optional peer (kv / cpeer) registry for inject/decode */
  peerRegistry?: TypeRegistry
  kernelCalls: MockKernelCall[]
  methodId: (name: string) => number
  cleanup: () => Promise<void>
}

type ShieldBootstrap = {
  kernel: Kernel
  rootDir: string
  fsHandle: FsProcessHandle
  shield: ModuleProcess
  store: ModuleProcess
  recorder: ModuleProcess
  client: LocalProcess
  userClient: SocketRpcClient
  userRegistry: TypeRegistry
  userSocket: LocalSocket
  kernelCalls: MockKernelCall[]
  methodId: (name: string) => number
  shieldDesc: TypeRegistry
}

async function bootstrapRecorderStack(rootDir: string): Promise<ShieldBootstrap> {
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
  await shieldClient.call(registerId, STORE_ID, CLIENT_ID, false)
  await shieldClient.call(registerId, RECORDER_ID, CLIENT_ID, false)

  client.unbind(shield, 10, 0, Direction.BOTH)
  recorder.bind(shield, 1, 0, Direction.BOTH)

  const userSocket = client.createSocket(0, LARGE_SOCKET_OPTS)
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

  return {
    kernel,
    rootDir,
    fsHandle,
    shield,
    store,
    recorder,
    client,
    userClient,
    userRegistry,
    userSocket,
    kernelCalls,
    methodId,
    shieldDesc,
  }
}

/**
 * Steal shield USER from recorder, run fn with SocketRpcClient, restore recorder bind.
 */
let shieldUserSocketSeq = 40

export async function withShieldUserClient<T>(
  ctx: {
    client: LocalProcess
    shield: ModuleProcess
    recorder: ModuleProcess
    shieldDesc: TypeRegistry
  },
  fn: (sc: SocketRpcClient, methodId: (name: string) => number) => Promise<T>
): Promise<T> {
  ctx.recorder.unbind(ctx.shield, 1, 0, Direction.BOTH)
  const localId = shieldUserSocketSeq++
  const sock = ctx.client.createSocket(localId, SOCKET_OPTS)
  ctx.client.bind(ctx.shield, localId, 0, Direction.BOTH)
  ctx.client.setRpcDescription(localId, ctx.shieldDesc)
  const codecs = new CodecRegistry()
  registerDynamicCodecs(codecs, ctx.shieldDesc)
  ensureRpcCodecs(codecs, ctx.shieldDesc)
  const sc = new SocketRpcClient(sock, ctx.shieldDesc, codecs)
  const methods = new Map(ctx.shieldDesc.getMethods().map((m) => [m.memberName, m.methodId]))
  const methodId = (name: string) => {
    const id = methods.get(name.includes('.') ? name : `kernel_shield.${name}`)
      ?? methods.get(name)
    if (id === undefined) {
      throw new Error(`missing shield method ${name}; have: ${[...methods.keys()].join(', ')}`)
    }
    return id
  }
  try {
    return await fn(sc, methodId)
  } finally {
    ctx.client.unbind(ctx.shield, localId, 0, Direction.BOTH)
    ctx.recorder.bind(ctx.shield, 1, 0, Direction.BOTH)
  }
}

/**
 * Spawn WASM as ModuleProcess, register with shield, bind KERNEL_API
 * (process.1 ↔ shield.(pid<<1)|1).
 *
 * Uses host `kernel.spawn` rather than `kernel_shield.spawn`: dbg_*.wasm are
 * multi‑MB and the shield KERNEL socket buffers (~1KiB) cannot carry the code blob.
 * Topology after this helper matches a typical shield-wired process.
 */
export async function spawnAndWireViaShield(
  ctx: {
    client: LocalProcess
    shield: ModuleProcess
    recorder: ModuleProcess
    shieldDesc: TypeRegistry
    kernel: Kernel
  },
  code: Uint8Array,
  memoryPages = 16,
  manaLimit = 5_000_000
): Promise<number> {
  const pid = await ctx.kernel.spawn(code, memoryPages, manaLimit)
  await withShieldUserClient(ctx, async (sc, methodId) => {
    await sc.call(methodId('register_process'), pid, CLIENT_ID, false)
    await sc.call(
      methodId('bind'),
      pid,
      1,
      SHIELD_ID,
      (pid << 1) | 1,
      Direction.BOTH
    )
  })
  return pid
}

/**
 * Typical topology: spawn peer + client via shield, bind KERNEL_API,
 * bind client.2 ↔ peer.0, host SocketRpcClient on client.0.
 *
 * Defaults match dbg_token + dbg_kv (flat). Pass targetRpcFormat: 'compressed'
 * for dbg_cclient; peer registry builder for inject/decode of compressed peer.
 */
export async function setupTokenKvEnvironment(
  rootDir: string,
  options: {
    tokenWasmPath: string
    kvWasmPath: string
    buildTokenRegistry: () => TypeRegistry
    buildPeerRegistry?: () => TypeRegistry
    targetRpcFormat?: 'flat' | 'compressed'
  }
): Promise<TokenKvRecordingContext> {
  const base = await bootstrapRecorderStack(rootDir)
  const tokenCode = await readFile(options.tokenWasmPath)
  const kvCode = await readFile(options.kvWasmPath)
  const targetRpcFormat = options.targetRpcFormat ?? 'flat'

  const kvPid = await spawnAndWireViaShield(base, kvCode)
  const tokenPid = await spawnAndWireViaShield(base, tokenCode)

  await withShieldUserClient(base, async (sc, methodId) => {
    await sc.call(
      methodId('bind'),
      tokenPid,
      2,
      kvPid,
      0,
      Direction.BOTH
    )
  })

  const target = base.kernel.processes[tokenPid] as ModuleProcess
  const kv = base.kernel.processes[kvPid] as ModuleProcess
  if (!target || !kv) {
    throw new Error(`spawned processes missing: token=${tokenPid} kv=${kvPid}`)
  }

  const targetSock = base.client.createSocket(20, SOCKET_OPTS)
  base.client.bind(target, 20, 0, Direction.BOTH)

  let targetRegistry = options.buildTokenRegistry()
  try {
    const raw = target.readRawRpcDescription(0)
    if (raw && raw.length > 0) {
      const fromWasm = deserializeTypeRegistry(raw)
      fromWasm.assignMethodIds()
      targetRegistry = fromWasm
    }
  } catch {
    /* keep host registry */
  }

  let peerRegistry: TypeRegistry | undefined
  if (options.buildPeerRegistry) {
    peerRegistry = options.buildPeerRegistry()
    try {
      const raw = kv.readRawRpcDescription(0)
      if (raw && raw.length > 0) {
        const fromWasm = deserializeTypeRegistry(raw)
        fromWasm.assignMethodIds()
        peerRegistry = fromWasm
      }
    } catch {
      /* keep host peer registry */
    }
  }

  base.client.setRpcDescription(20, targetRegistry)
  const targetCodecs = new CodecRegistry()
  registerDynamicCodecs(targetCodecs, targetRegistry)
  ensureRpcCodecs(targetCodecs, targetRegistry)
  const targetClient = new SocketRpcClient(targetSock, targetRegistry, targetCodecs, {
    format: targetRpcFormat,
  })

  return {
    kernel: base.kernel,
    rootDir: base.rootDir,
    fsHandle: base.fsHandle,
    shield: base.shield,
    store: base.store,
    recorder: base.recorder,
    client: base.client,
    target,
    tokenPid,
    kvPid,
    kv,
    userClient: base.userClient,
    userRegistry: base.userRegistry,
    userSocket: base.userSocket,
    targetClient,
    targetRegistry,
    peerRegistry,
    kernelCalls: base.kernelCalls,
    methodId: base.methodId,
    cleanup: async () => {
      try { await target.kill(undefined) } catch { /* ignore */ }
      try { await kv.kill(undefined) } catch { /* ignore */ }
      try { await base.recorder.kill(undefined) } catch { /* ignore */ }
      try { await base.store.kill(undefined) } catch { /* ignore */ }
      try { await base.shield.kill(undefined) } catch { /* ignore */ }
    },
  }
}

export function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v)
  return Number(v)
}

export function storeSessionRegistry(store: ModuleProcess, storeSocket: number): TypeRegistry {
  const registry = deserializeTypeRegistry(store.readRawRpcDescription(storeSocket))
  registry.assignMethodIds()
  return registry
}

export function deserializeTypedBytes(
  registry: TypeRegistry,
  typeName: string,
  bytes: Uint8Array
): Record<string, unknown> {
  const codecs = new CodecRegistry()
  registerDynamicCodecs(codecs, registry)
  ensureRpcCodecs(codecs, registry)
  const buffer = new LocalCircularBuffer(Math.max(bytes.length + 256, 1024))
  buffer.write(bytes, bytes.length)
  const reader = new LocalCircularBufferReader(buffer, codecs)
  return deserializeTypedJson(reader, registry, typeName) as Record<string, unknown>
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
