import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { gzipSync } from 'node:zlib'
import { ensureMihomo } from '../scripts/lib/mihomo.ts'

it('downloads the locked release and reuses its cache without network access', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mihomo-locked-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const tag = (await readFile(new URL('../.mihomo-version', import.meta.url), 'utf8')).trim()
  const archive = gzipSync(Buffer.from(tag))
  const metadataUrl = `https://api.github.com/repos/MetaCubeX/mihomo/releases/tags/${tag}`
  const assetUrl = `https://github.com/MetaCubeX/mihomo/releases/download/${tag}/mihomo.gz`
  const options = {
    directory,
    bin: '',
    platform: 'linux',
    arch: 'x64',
    verify: async (path: string) => `Mihomo Meta ${await readFile(path, 'utf8')} linux amd64`,
    fetch: (async (input) => {
      if (String(input) === metadataUrl) {
        return Response.json({
          tag_name: tag,
          draft: false,
          prerelease: false,
          assets: [{
            name: `mihomo-linux-amd64-${tag}.gz`,
            digest: `sha256:${createHash('sha256').update(archive).digest('hex')}`,
            browser_download_url: assetUrl,
          }],
        })
      }
      assert.equal(String(input), assetUrl)
      return new Response(archive)
    }) satisfies typeof fetch,
  }
  const path = await ensureMihomo(options)
  assert.equal(path, join(directory, `linux-amd64-${tag}`))
  assert.equal(await ensureMihomo({ ...options, fetch: async () => {
    throw new Error('offline')
  } }), path)
})

it('preserves the cached executable on failed refresh and isolates versions', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mihomo-download-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const original = 'v1.2.3\noriginal executable'
  const replacement = 'v1.2.3\nreplacement executable'
  let contents = original
  let badDigest = false
  let badExecutable = false
  const request: typeof fetch = async (input) => {
    const [tag] = contents.split('\n', 1)
    const archive = gzipSync(Buffer.from(contents))
    if (String(input).startsWith('https://api.github.com/')) {
      return Response.json({
        tag_name: tag,
        draft: false,
        prerelease: false,
        assets: [{
          name: `mihomo-linux-amd64-${tag}.gz`,
          digest: `sha256:${badDigest ? '0'.repeat(64) : createHash('sha256').update(archive).digest('hex')}`,
          browser_download_url: `https://github.com/MetaCubeX/mihomo/releases/download/${tag}/mihomo.gz`,
        }],
      })
    }
    return new Response(archive)
  }
  const options = {
    directory,
    bin: '',
    version: 'v1.2.3',
    platform: 'linux',
    arch: 'x64',
    fetch: request,
    verify: async (path: string) => {
      const [version] = (await readFile(path, 'utf8')).split('\n', 1)
      return `Mihomo Meta ${badExecutable ? 'v0.0.0' : version} linux amd64`
    },
  }
  // 兼容旧版本中断后残留的锁；不清除可能属于旧进程的目录。
  const legacyLock = join(directory, 'linux-amd64-v1.2.3.lock')
  await mkdir(legacyLock)
  await writeFile(join(legacyLock, 'owner'), 'leave untouched')
  const path = await ensureMihomo(options)
  assert.equal(await readFile(path, 'utf8'), original)
  contents = replacement
  badDigest = true
  await assert.rejects(ensureMihomo({ ...options, force: true }), /SHA-256 mismatch/)
  assert.equal(await readFile(path, 'utf8'), original)
  badDigest = false
  badExecutable = true
  await assert.rejects(ensureMihomo({ ...options, force: true }), /version mismatch/)
  assert.equal(await readFile(path, 'utf8'), original)
  badExecutable = false
  contents = 'v1.2.4\nnew version'
  await assert.rejects(ensureMihomo({ ...options, force: true }), /requested stable version/)
  const pinned = await ensureMihomo({ ...options, version: 'v1.2.4' })
  assert.notEqual(pinned, path)
  assert.equal(await readFile(pinned, 'utf8'), contents)
  contents = replacement
  await assert.rejects(ensureMihomo({ ...options, force: true, fetch: async () => new Response(null, { status: 503 }) }), /HTTP 503/)
  assert.equal(await readFile(path, 'utf8'), original)
  assert.equal(await readFile(join(legacyLock, 'owner'), 'utf8'), 'leave untouched')

  // 一个下载暂停时，另一个可以完成；暂停者失败也不能清理其他调用的产物。
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const pending = ensureMihomo({ ...options, force: true, fetch: async () => {
    entered.resolve()
    await release.promise
    throw new Error('interrupted download')
  } })
  const failed = assert.rejects(pending, /interrupted download/)
  try {
    await entered.promise
    await ensureMihomo({ ...options, force: true })
  }
  finally {
    release.resolve()
    await failed
  }
  assert.equal(await ensureMihomo(options), path)
  assert.equal(await readFile(path, 'utf8'), replacement)
})

it('respects external binaries and rejects unsupported downloads without network access', async () => {
  const options = { fetch: async () => {
    throw new Error('must not download')
  } }
  assert.equal(await ensureMihomo({ ...options, bin: 'mihomo', verify: async () => 'Mihomo v1.2.3 linux amd64' }), 'mihomo')
  await assert.rejects(ensureMihomo({ ...options, bin: 'mihomo', force: true }), /cannot replace MIHOMO_BIN/)
  await assert.rejects(ensureMihomo({ ...options, bin: 'invalid', verify: async () => {
    throw new Error('invalid binary')
  } }), /invalid binary/)
  await assert.rejects(ensureMihomo({ ...options, bin: '', version: '../escape' }), /\.mihomo-version/)
  await assert.rejects(ensureMihomo({ ...options, bin: '', platform: 'win32' }), /set MIHOMO_BIN/)
})
