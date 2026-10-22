import { expect } from 'chai'
import fsp from 'node:fs/promises'
import { readFile, access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { LocalProcess, Direction, kernelApi } from '@daemonarium/kernel'
import { SocketRpcClient, CodecRegistry, registerDynamicCodecs, ensureRpcCodecs, deserializeTypeRegistry } from '@daemonarium/rpc'
import {
  setupWasmTargetEnvironment,
  withTempRoot,
  num,
  tick,
  STORE_ID,
  TARGET_ID,
  CLIENT_ID,
  SOCKET_OPTS,
  storeSessionRegistry,
  deserializeTypedBytes,
} from './setup.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const MOCK_MODULE_WASM = join(
  __dirname,
  '../../extern/kernel-shield-cpp/build-web/kernel-shield/cpp-test/mock-module.wasm'
)

const WAOSREC_BIN_CANDIDATES = [
  join(__dirname, '../../build/waosrec'),
]

async function resolveWaosrecBin(): Promise<string | null> {
  for (const p of WAOSREC_BIN_CANDIDATES) {
    try {
      await access(p, fsConstants.X_OK)
      return p
    } catch {
      /* try next */
    }
  }
  return null
}

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

describe('recorder WASM e2e (real mock-module target)', () => {
  it('records real echo I/O until process error and writes session files', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupWasmTargetEnvironment(root)
      try {
        const sessionName = 'e2e-mock-echo'
        const moduleCode = await readFile(MOCK_MODULE_WASM)
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
          code: moduleCode,
        }) as Record<string, unknown>

        await tick(20)
        const saveCalls = ctx.kernelCalls.filter((c) => c.method === 'kernel.save')
        expect(saveCalls.length).to.be.greaterThan(0)
        // Initial recording save — not a later dump_on_error save after kill.
        const saveResult = saveCalls[0]!.result as {
          memory: Uint8Array
          snapshot_uid: bigint | number
        }
        // get_memory() returns a live view — copy before further target I/O mutates it.
        const anchorMemory = Uint8Array.from(saveResult.memory)
        expect(anchorMemory.byteLength).to.be.greaterThan(0)
        const snapUid = String(num(saveResult.snapshot_uid))

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
        const sessionReg = storeSessionRegistry(ctx.store, num(result.store_socket))
        const meta = deserializeTypedBytes(
          sessionReg,
          'session_meta',
          await fsp.readFile(join(dir, 'meta.bin'))
        )
        expect(meta.name).to.equal(sessionName)
        expect(meta.status).to.equal('open')
        expect(num(meta.process_id)).to.equal(TARGET_ID)

        await tick(100)

        const bindings = deserializeTypedBytes(
          sessionReg,
          'bindings_snapshot',
          await fsp.readFile(join(dir, 'bindings.bin'))
        )
        expect(num(bindings.process_id)).to.equal(TARGET_ID)
        expect(bindings.bindings).to.be.an('array')
        await fsp.access(join(dir, `registry.${TARGET_ID}.0.bin`))

        const codeOnDisk = await fsp.readFile(join(dir, 'code.wasm'))
        expect(Buffer.from(codeOnDisk).equals(Buffer.from(moduleCode))).to.equal(true)

        const snaps = (await fsp.readdir(dir)).filter(
          (f) => f.startsWith('snap.') && f.endsWith('.bin') && !f.includes('.meta.')
        )
        expect(snaps.length).to.be.greaterThan(0)
        const snapName = `snap.${snapUid}.bin`
        expect(snaps, `missing ${snapName} in ${snaps.join(',')}`).to.include(snapName)

        const snapBytes = await fsp.readFile(join(dir, snapName))
        expect(Buffer.from(snapBytes).equals(Buffer.from(anchorMemory))).to.equal(true)

        const snapMeta = deserializeTypedBytes(
          sessionReg,
          'snapshot_meta',
          await fsp.readFile(join(dir, `snap.${snapUid}.meta.bin`))
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

        const waosrec = await resolveWaosrecBin()
        expect(waosrec, 'native waosrec binary (build with NOT WASM)').to.be.a('string')
        const outPath = join(root, 'session.waosrec')
        const pack = spawnSync(waosrec!, ['pack', dir, '-o', outPath], { encoding: 'utf8' })
        expect(pack.status, pack.stderr).to.equal(0)
        const info = spawnSync(waosrec!, ['info', outPath], { encoding: 'utf8' })
        expect(info.status, info.stderr).to.equal(0)
        expect(info.stdout).to.match(new RegExp(`code_bytes=${moduleCode.length}`))
        expect(info.stdout).to.match(/memory_bytes=\d+/)
        expect(info.stdout).to.match(/events_bytes=\d+/)
      } finally {
        await ctx.cleanup()
      }
    })
  })

  it('mid-session host bind captures BIND frame and peer registry', async () => {
    await withTempRoot(async (root) => {
      const ctx = await setupWasmTargetEnvironment(root)
      try {
        const result = await ctx.userClient.call(ctx.methodId('start_recording'), {
          target_process: BigInt(TARGET_ID),
          store_process: BigInt(STORE_ID),
          session_name: 'e2e-mid-bind',
          labels: {},
          config: {
            event_buffer_snapshot_mult: 2,
            record_mana: false,
            dump_on_error: false,
          },
          code: new Uint8Array(),
        }) as Record<string, unknown>

        await tick(20)

        const peerId = 30
        const { kernelApi: kernelApiDyn } = await import('@daemonarium/kernel')
        const peer = new LocalProcess(ctx.kernel, peerId, 1_000_000)
        while (ctx.kernel.processes.length <= peerId) {
          ctx.kernel.processes.push(null)
        }
        ctx.kernel.processes[peerId] = peer
        peer.createSocket(0, SOCKET_OPTS)
        peer.setRpcDescription(0, kernelApiDyn.createGeneratedTypeRegistry().registry)
        await registerWithShield(ctx, peerId)

        // Real kernel bind emits process_bind_event to monitors with BIND.
        await ctx.kernel.bind(TARGET_ID, 0, peerId, 0, kernelApi.direction.BOTH)
        await tick(100)

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
})
