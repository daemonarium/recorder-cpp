import { expect } from 'chai'
import fsp from 'node:fs/promises'
import { join } from 'node:path'
import {
  setupWasmTargetEnvironment,
  withTempRoot,
  num,
  tick,
  STORE_ID,
  TARGET_ID,
} from './setup.js'

describe('recorder WASM e2e (real mock-module target)', () => {
  it('records real echo I/O until process error and writes session files', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupWasmTargetEnvironment(root)
      try {
        const sessionName = 'e2e-mock-echo'
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: sessionName,
          labels: { scenario: 'e2e' },
          config: {
            event_buffer_snapshot_mult: 2,
            record_mana: false,
            dump_on_error: true,
          },
        }) as Record<string, unknown>

        await tick(20)
        const saveCalls = ctx.kernelCalls.filter((c) => c.method === 'kernel.save')
        expect(saveCalls.length).to.be.greaterThan(0)
        const saveResult = saveCalls[saveCalls.length - 1].result as {
          memory: Uint8Array
          snapshot_uid: bigint | number
        }
        // get_memory() returns a live view — copy before further target I/O mutates it.
        const anchorMemory = Uint8Array.from(saveResult.memory)
        expect(anchorMemory.byteLength).to.be.greaterThan(0)

        const payloadA = new TextEncoder().encode('hello-rec-1')
        const payloadB = new Uint8Array([0xde, 0xad, 0xbe, 0xef])

        const echoedA = await ctx.echo(payloadA)
        expect(Buffer.from(echoedA).equals(Buffer.from(payloadA))).to.equal(true)
        const echoedB = await ctx.echo(payloadB)
        expect(Buffer.from(echoedB).equals(Buffer.from(payloadB))).to.equal(true)
        await tick(30)

        await ctx.kernel.kill(TARGET_ID, 'example-crash')
        await tick(80)

        const sessionId = num(result.store_session_id)
        const dir = join(root, 'sessions', String(sessionId))
        const meta = JSON.parse(await fsp.readFile(join(dir, 'meta.json'), 'utf8'))
        expect(meta.name).to.equal(sessionName)
        expect(meta.status).to.equal('open')
        expect(meta.process_id).to.equal(TARGET_ID)

        const snaps = (await fsp.readdir(dir)).filter((f) => f.startsWith('snap.') && f.endsWith('.bin'))
        expect(snaps.length).to.be.greaterThan(0)
        const snapName = snaps[0]
        const uidMatch = /^snap\.(\d+)\.bin$/.exec(snapName)
        expect(uidMatch).to.be.ok
        const snapUid = uidMatch![1]

        const snapBytes = await fsp.readFile(join(dir, snapName))
        expect(Buffer.from(snapBytes).equals(Buffer.from(anchorMemory))).to.equal(true)

        const snapMeta = JSON.parse(
          await fsp.readFile(join(dir, `snap.${snapUid}.meta.json`), 'utf8')
        )
        expect(num(snapMeta.snapshot_uid)).to.equal(Number(snapUid))
        expect(num(snapMeta.memory_size)).to.equal(anchorMemory.length)

        const io = await fsp.readFile(join(dir, 'io.bin'))
        expect(io.length).to.be.greaterThan(0)
        expect(Buffer.from(io).includes(Buffer.from(payloadA))).to.equal(true)
        expect(Buffer.from(io).includes(Buffer.from(payloadB))).to.equal(true)

        expect(ctx.target.isAlive).to.equal(false)
        expect(ctx.recorder.isAlive).to.equal(true)
        expect(ctx.store.isAlive).to.equal(true)
      } finally {
        await ctx.cleanup()
      }
    })
  })
})
