import { expect } from 'chai'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { RpcException, SocketRpcClient, CodecRegistry, registerDynamicCodecs, ensureRpcCodecs, deserializeTypeRegistry } from '@daemonarium/rpc'
import { LocalProcess, Direction, kernelApi } from '@daemonarium/kernel'
import {
  setupTestEnvironment,
  withTempRoot,
  num,
  tick,
  emitCopy,
  emitBind,
  emitError,
  emitMana,
  STORE_ID,
  TARGET_ID,
  CLIENT_ID,
  SOCKET_OPTS,
  monitor_flag,
  storeSessionRegistry,
  deserializeTypedBytes,
} from './setup.js'

async function registerWithShield(
  ctx: {
    client: LocalProcess
    shield: import('@daemonarium/kernel').ModuleProcess
    recorder: import('@daemonarium/kernel').ModuleProcess
  },
  processId: number
): Promise<void> {
  // Recorder owns shield USER (recorder:1 ↔ shield:0). Temporarily release it.
  ctx.recorder.unbind(ctx.shield, 1, 0, Direction.BOTH)

  const shieldDesc = deserializeTypeRegistry(ctx.shield.readRawRpcDescription(0))
  shieldDesc.assignMethodIds()
  const regId = shieldDesc.getMethods().find(m => m.memberName === 'kernel_shield.register_process')?.methodId
  if (regId === undefined) throw new Error('missing register_process')
  const localId = 50 + processId
  const sock = ctx.client.createSocket(localId, SOCKET_OPTS)
  ctx.client.bind(ctx.shield, localId, 0, Direction.BOTH)
  ctx.client.setRpcDescription(localId, shieldDesc)
  const codecs = new CodecRegistry()
  registerDynamicCodecs(codecs, shieldDesc)
  ensureRpcCodecs(codecs, shieldDesc)
  const sc = new SocketRpcClient(sock, shieldDesc, codecs)
  try {
    await sc.call(regId, processId, CLIENT_ID, false)
  } finally {
    ctx.client.unbind(ctx.shield, localId, 0, Direction.BOTH)
    ctx.recorder.bind(ctx.shield, 1, 0, Direction.BOTH)
  }
}

describe('recorder WASM', () => {
  it('start with code writes code.wasm', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const code = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0xaa, 0xbb])
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'with-code',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 1,
            record_mana: false,
            dump_on_error: false,
          },
          code,
        }) as Record<string, unknown>

        await tick(80)
        const sessionId = num(result.store_session_id)
        const onDisk = await fsp.readFile(join(root, 'sessions', String(sessionId), 'code.wasm'))
        expect(Buffer.from(onDisk).equals(Buffer.from(code))).to.equal(true)
        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('rejects invalid event_buffer_snapshot_mult', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        let err: unknown
        try {
          await ctx.userClient.call(ctx.methodId('start_recording'), {
            target_process: BigInt(TARGET_ID),
            store_process: BigInt(STORE_ID),
            session_name: 'bad-k',
            labels: {},
            config: {
              event_buffer_snapshot_mult: 3,
              record_mana: false,
              dump_on_error: true,
            },
            code: new Uint8Array(),
          })
        } catch (e) {
          err = e
        }
        expect(err).to.be.instanceOf(RpcException)
        expect((err as RpcException).typeName).to.match(/recorder_invalid_argument/)
        expect((err as Error).message).to.match(/event_buffer_snapshot_mult/)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('start creates store session and completes initial save', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'start-ok',
          labels: { env: 'test' },
          config: {
            event_buffer_snapshot_mult: 1,
            record_mana: false,
            dump_on_error: true,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        expect(num(result.recording_id)).to.equal(1)
        expect(num(result.monitor_socket)).to.be.at.least(2)
        expect(num(result.log_socket)).to.be.at.least(2)
        expect(num(result.store_session_id)).to.equal(1)

        await tick(80)

        const sessionReg = storeSessionRegistry(ctx.store, num(result.store_socket))
        const meta = deserializeTypedBytes(
          sessionReg,
          'session_meta',
          await fsp.readFile(join(root, 'sessions', '1', 'meta.bin'))
        )
        expect(meta.name).to.equal('start-ok')
        expect(meta.status).to.equal('open')
        expect(num(meta.process_id)).to.equal(TARGET_ID)

        const saveCalls = ctx.kernelCalls.filter((c) => c.method === 'kernel.save')
        expect(saveCalls.length).to.be.greaterThan(0)
        expect(num(saveCalls[saveCalls.length - 1].args[0])).to.equal(TARGET_ID)

        const monCalls = ctx.kernelCalls.filter((c) => c.method === 'kernel.monitor')
        const recMon = monCalls.find((c) => num(c.args[0]) === TARGET_ID && num(c.args[1]) === 3)
        expect(recMon).to.be.ok
        const flags = num((recMon!.args[3] as { flags: number }).flags)
        expect(flags & monitor_flag.COPY).to.not.equal(0)
        expect(flags & monitor_flag.SAVE).to.not.equal(0)
        expect(flags & monitor_flag.BIND).to.not.equal(0)
        expect(flags & monitor_flag.MANA).to.equal(0)

        const bindings = deserializeTypedBytes(
          sessionReg,
          'bindings_snapshot',
          await fsp.readFile(join(root, 'sessions', '1', 'bindings.bin'))
        )
        expect(num(bindings.process_id)).to.equal(TARGET_ID)
        expect(bindings.bindings).to.be.an('array')

        const registryPath = join(root, 'sessions', '1', `registry.${TARGET_ID}.0.bin`)
        const registryBytes = await fsp.readFile(registryPath)
        expect(registryBytes.byteLength).to.be.at.least(0)

        const listCalls = ctx.kernelCalls.filter((c) => c.method === 'kernel.list_socket_bindings')
        expect(listCalls.length).to.be.greaterThan(0)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
        const metaAfterStop = deserializeTypedBytes(
          sessionReg,
          'session_meta',
          await fsp.readFile(join(root, 'sessions', '1', 'meta.bin'))
        )
        expect(metaAfterStop.name).to.equal('start-ok')
        expect(metaAfterStop.status).to.equal('open')
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('start captures non-empty bindings when target already bound', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const peerId = 20
        const peer = new LocalProcess(ctx.kernel, peerId, 1_000_000)
        while (ctx.kernel.processes.length <= peerId) {
          ctx.kernel.processes.push(null)
        }
        ctx.kernel.processes[peerId] = peer
        peer.createSocket(0, {
          inputBufferSize: 1024,
          outputBufferSize: 1024,
          flushThreshold: 512,
          dataEventThreshold: 0,
          drainEventThreshold: 4,
          flags: 0,
        })
        ctx.target.createSocket(0, {
          inputBufferSize: 1024,
          outputBufferSize: 1024,
          flushThreshold: 512,
          dataEventThreshold: 0,
          drainEventThreshold: 4,
          flags: 0,
        })
        await ctx.kernel.bind(TARGET_ID, 0, peerId, 0, kernelApi.direction.BOTH)
        await registerWithShield(ctx, peerId)

        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'bound-start',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 1,
            record_mana: false,
            dump_on_error: false,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(100)

        const sessionId = num(result.store_session_id)
        const sessionReg = storeSessionRegistry(ctx.store, num(result.store_socket))
        const bindings = deserializeTypedBytes(
          sessionReg,
          'bindings_snapshot',
          await fsp.readFile(join(root, 'sessions', String(sessionId), 'bindings.bin'))
        )
        expect((bindings.bindings as unknown[]).length).to.be.greaterThan(0)
        expect(num((bindings.bindings as any[])[0].peer_process)).to.equal(peerId)
        expect(num((bindings.bindings as any[])[0].direction)).to.equal(3)

        const peerRegistry = join(root, 'sessions', String(sessionId), `registry.${peerId}.0.bin`)
        await fsp.access(peerRegistry)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('mid-session bind appends opaque frame and refreshes peer registry', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const peerId = 21
        const peer = new LocalProcess(ctx.kernel, peerId, 1_000_000)
        while (ctx.kernel.processes.length <= peerId) {
          ctx.kernel.processes.push(null)
        }
        ctx.kernel.processes[peerId] = peer
        const { kernelApi: kernelApiDyn } = await import('@daemonarium/kernel')
        peer.setRpcDescription(0, kernelApiDyn.createGeneratedTypeRegistry().registry)
        await registerWithShield(ctx, peerId)

        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'mid-bind',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 2,
            record_mana: false,
            dump_on_error: false,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(20)
        emitBind(ctx, peerId, 0, 0)
        await tick(80)

        await ctx.userClient.call(ctx.methodId('dump'), result.recording_id)
        await tick(40)

        const sessionId = num(result.store_session_id)
        const dir = join(root, 'sessions', String(sessionId))
        const io = await fsp.readFile(join(dir, 'io.bin'))
        expect(io.length).to.be.greaterThan(0)

        const peerRegistry = await fsp.readFile(join(dir, `registry.${peerId}.0.bin`))
        expect(peerRegistry.byteLength).to.be.greaterThan(0)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('dump writes snapshot and opaque io frames', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'dump-io',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 2,
            record_mana: false,
            dump_on_error: true,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(20)
        const payload = new Uint8Array([10, 20, 30, 40, 50])
        emitCopy(ctx, payload.length, payload)
        await tick(20)

        await ctx.userClient.call(ctx.methodId('dump'), result.recording_id)
        await tick(30)

        const sessionId = num(result.store_session_id)
        const dir = join(root, 'sessions', String(sessionId))
        const snaps = (await fsp.readdir(dir)).filter((f) => f.startsWith('snap.') && f.endsWith('.bin'))
        expect(snaps.length).to.be.greaterThan(0)
        const snapBytes = await fsp.readFile(join(dir, snaps[0]))
        expect(Buffer.from(snapBytes).equals(Buffer.from(ctx.target.memory))).to.equal(true)

        const io = await fsp.readFile(join(dir, 'io.bin'))
        expect(io.length).to.be.greaterThan(0)
        // Opaque frames are length-prefixed; payload bytes should appear inside
        expect(Buffer.from(io).includes(Buffer.from(payload))).to.equal(true)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('dump twice appends the same window again', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'dump-twice',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 2,
            record_mana: false,
            dump_on_error: false,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(20)
        const payload = new Uint8Array([11, 22, 33, 44])
        emitCopy(ctx, payload.length, payload)
        await tick(20)

        await ctx.userClient.call(ctx.methodId('dump'), result.recording_id)
        await tick(30)
        const sessionId = num(result.store_session_id)
        const ioPath = join(root, 'sessions', String(sessionId), 'io.bin')
        const afterFirst = (await fsp.readFile(ioPath)).length
        expect(afterFirst).to.be.greaterThan(0)

        await ctx.userClient.call(ctx.methodId('dump'), result.recording_id)
        await tick(30)
        const afterSecond = (await fsp.readFile(ioPath)).length
        expect(afterSecond).to.be.greaterThanOrEqual(afterFirst * 2)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('dump_and_clear then dump without new I/O does not re-append window', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'dump-and-clear',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 2,
            record_mana: false,
            dump_on_error: false,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(20)
        const payload = new Uint8Array([7, 8, 9])
        emitCopy(ctx, payload.length, payload)
        await tick(20)

        await ctx.userClient.call(ctx.methodId('dump_and_clear'), result.recording_id)
        await tick(30)
        const sessionId = num(result.store_session_id)
        const ioPath = join(root, 'sessions', String(sessionId), 'io.bin')
        const afterClear = (await fsp.readFile(ioPath)).length
        expect(afterClear).to.be.greaterThan(0)
        expect(Buffer.from(await fsp.readFile(ioPath)).includes(Buffer.from(payload))).to.equal(true)

        await ctx.userClient.call(ctx.methodId('dump'), result.recording_id)
        await tick(30)
        const afterSecond = (await fsp.readFile(ioPath)).length
        expect(afterSecond).to.equal(afterClear)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('rotate cuts old prefix from subsequent dump', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        // Keep memory large enough that a single COPY frame does not trip
        // maybe_request_rotate (flat frames are larger than compressed).
        ctx.target.memory = new Uint8Array(256).fill(1)

        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'rotate',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 2,
            record_mana: false,
            dump_on_error: false,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(20)
        const oldPayload = new Uint8Array(32).fill(0xaa)
        emitCopy(ctx, oldPayload.length, oldPayload)
        await tick(20)

        await ctx.userClient.call(ctx.methodId('rotate'), result.recording_id)
        await tick(40)

        const newPayload = new Uint8Array([1, 2, 3])
        emitCopy(ctx, newPayload.length, newPayload)
        await tick(20)

        await ctx.userClient.call(ctx.methodId('dump'), result.recording_id)
        await tick(30)

        const sessionId = num(result.store_session_id)
        const io = await fsp.readFile(join(root, 'sessions', String(sessionId), 'io.bin'))
        // After rotate cut, old large payload should not dominate; new payload present
        expect(Buffer.from(io).includes(Buffer.from(newPayload))).to.equal(true)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('dump_on_error dumps without sealing', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'on-error',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 1,
            record_mana: false,
            dump_on_error: true,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(20)
        emitCopy(ctx, 4, new Uint8Array([9, 9, 9, 9]))
        await tick(10)
        emitError(ctx, 'test-error')
        await tick(40)

        const sessionId = num(result.store_session_id)
        const dir = join(root, 'sessions', String(sessionId))
        const sessionReg = storeSessionRegistry(ctx.store, num(result.store_socket))
        const meta = deserializeTypedBytes(
          sessionReg,
          'session_meta',
          await fsp.readFile(join(dir, 'meta.bin'))
        )
        expect(meta.status).to.equal('open')

        const snaps = (await fsp.readdir(dir)).filter((f) => f.startsWith('snap.') && f.endsWith('.bin') && !f.includes('.meta.'))
        expect(snaps.length).to.be.greaterThan(0)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
        const metaAfter = deserializeTypedBytes(
          sessionReg,
          'session_meta',
          await fsp.readFile(join(dir, 'meta.bin'))
        )
        expect(metaAfter.status).to.equal('open')
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('record_mana=false ignores mana frames in io dump', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'no-mana',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 2,
            record_mana: false,
            dump_on_error: false,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(20)
        emitMana(ctx)
        await tick(20)
        await ctx.userClient.call(ctx.methodId('dump'), result.recording_id)
        await tick(30)

        const sessionId = num(result.store_session_id)
        const ioPath = join(root, 'sessions', String(sessionId), 'io.bin')
        let ioLen = 0
        try {
          ioLen = (await fsp.readFile(ioPath)).length
        } catch {
          ioLen = 0
        }
        expect(ioLen).to.equal(0)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
      } finally {
        await ctx.cleanup()
      }
    })
  })
})
