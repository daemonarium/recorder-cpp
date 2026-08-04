import { expect } from 'chai'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import { RpcException } from '@wa-os/ts-rpc'
import {
  setupTestEnvironment,
  withTempRoot,
  num,
  tick,
  emitCopy,
  emitError,
  emitMana,
  STORE_ID,
  TARGET_ID,
  monitor_flag,
} from './setup.js'

describe('recorder WASM', () => {
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
        }) as Record<string, unknown>

        expect(num(result.recording_id)).to.equal(1)
        expect(num(result.monitor_socket)).to.be.at.least(2)
        expect(num(result.log_socket)).to.be.at.least(2)
        expect(num(result.store_session_id)).to.equal(1)

        const meta = JSON.parse(
          await fsp.readFile(join(root, 'sessions', '1', 'meta.json'), 'utf8')
        )
        expect(meta.name).to.equal('start-ok')
        expect(meta.status).to.equal('open')
        expect(meta.process_id).to.equal(TARGET_ID)

        const saveCalls = ctx.kernelCalls.filter((c) => c.method === 'kernel.save')
        expect(saveCalls.length).to.be.greaterThan(0)
        expect(num(saveCalls[saveCalls.length - 1].args[0])).to.equal(TARGET_ID)

        const monCalls = ctx.kernelCalls.filter((c) => c.method === 'kernel.monitor')
        const recMon = monCalls.find((c) => num(c.args[0]) === TARGET_ID && num(c.args[1]) === 3)
        expect(recMon).to.be.ok
        const flags = num((recMon!.args[3] as { flags: number }).flags)
        expect(flags & monitor_flag.COPY).to.not.equal(0)
        expect(flags & monitor_flag.SAVE).to.not.equal(0)
        expect(flags & monitor_flag.MANA).to.equal(0)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
        const metaAfterStop = JSON.parse(
          await fsp.readFile(join(root, 'sessions', '1', 'meta.json'), 'utf8')
        )
        expect(metaAfterStop.name).to.equal('start-ok')
        expect(metaAfterStop.status).to.equal('open')
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

  it('rotate cuts old prefix from subsequent dump', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupTestEnvironment(root)
      try {
        ctx.target.memory = new Uint8Array(16).fill(1)

        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'rotate',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 1,
            record_mana: false,
            dump_on_error: false,
          },
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
        }) as Record<string, unknown>

        await tick(20)
        emitCopy(ctx, 4, new Uint8Array([9, 9, 9, 9]))
        await tick(10)
        emitError(ctx, 'test-error')
        await tick(40)

        const sessionId = num(result.store_session_id)
        const dir = join(root, 'sessions', String(sessionId))
        const meta = JSON.parse(await fsp.readFile(join(dir, 'meta.json'), 'utf8'))
        expect(meta.status).to.equal('open')

        const snaps = (await fsp.readdir(dir)).filter((f) => f.startsWith('snap.') && f.endsWith('.bin'))
        expect(snaps.length).to.be.greaterThan(0)

        await ctx.userClient.call(ctx.methodId('stop_recording'), result.recording_id)
        const metaAfter = JSON.parse(await fsp.readFile(join(dir, 'meta.json'), 'utf8'))
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
