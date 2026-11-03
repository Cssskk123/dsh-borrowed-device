/**
 * Ownership and cleanup tests — no DSH process, no real profile.
 *
 * Each case builds a throwaway `$DSH_HOME`, drives the plugin through a fake
 * Cordis context, and asserts on what actually landed on disk. These cover the
 * destructive half: which session directories, attachments and credentials a
 * wipe is allowed to touch.
 *
 * Run with: node test/smoke.mjs
 */
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createCredentials(store, options = {}) {
  const envFallback = options.envFallback !== false
  return {
    async describe(ref) {
      if (store.has(ref)) return { configured: true, writable: true, source: 'file' }
      if (envFallback && process.env[ref]) return { configured: true, writable: true, source: 'environment' }
      return { configured: false, writable: true, source: '' }
    },
    async resolve(ref) {
      if (store.has(ref)) return { value: store.get(ref), source: 'file' }
      if (envFallback && process.env[ref]) return { value: process.env[ref], source: 'environment' }
      return undefined
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
    async listRecords() {
      return []
    },
    async deleteRecord() {},
  }
}

function createHarness(store, options = {}) {
  const tools = []
  const listeners = new Map()
  const workspaces = options.workspaces ?? null
  const ctx = {
    logger: { warn() {}, info() {} },
    get(name) {
      if (name !== 'workspaceRegistry' || workspaces === null) return undefined
      return {
        list: () => [...workspaces.values()],
        delete: async (id) => {
          workspaces.delete(id)
          return true
        },
      }
    },
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, [])
      listeners.get(name).push(fn)
      return () => {}
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => undefined },
    credentials: createCredentials(store, options),
    emit(name, ...args) {
      for (const listener of listeners.get(name) ?? []) listener(...args)
    },
  }
  return { ctx, tools }
}

async function withHome(fn) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'bd-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await fsp.rm(home, { recursive: true, force: true })
  }
}

async function boot(home, options = {}) {
  const store = options.store ?? new Map()
  const harness = createHarness(store, options)
  apply(harness.ctx, options.config ?? {})
  await sleep(40)
  return { ...harness, store }
}

function tool(harness) {
  assert.ok(harness.tools.length > 0, 'plugin registered its tool')
  return harness.tools[0]
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test('a wipe deletes only the sessions created during the borrow', async () => {
  await withHome(async (home) => {
    const foreign = path.join(home, 'sessions', '--work--', 'session-foreign')
    await fsp.mkdir(foreign, { recursive: true })
    await fsp.writeFile(path.join(foreign, 'session.v4.jsonl.zstd'), 'x'.repeat(100))
    await sleep(20)

    const harness = await boot(home)

    const mine = path.join(home, 'sessions', '--work--', 'session-mine')
    await fsp.mkdir(mine, { recursive: true })
    await fsp.writeFile(path.join(mine, 'session.v4.jsonl.zstd'), 'y'.repeat(80))
    harness.ctx.emit('session/created', { id: 'session-mine' })
    await sleep(40)

    const audit = await tool(harness).execute({ action: 'audit' }, {})
    assert.ok(audit.findings.some((item) => item.id === 'sessions' && item.scope === 'mine'), 'my session listed')
    assert.ok(audit.findings.some((item) => item.id === 'sessions-foreign' && item.scope === 'foreign'), 'their session listed')

    const wipe = await tool(harness).execute({ action: 'wipe', confirm: true }, {})
    assert.equal(wipe.ok, true)
    await assert.rejects(fsp.stat(mine), 'my session deleted')
    assert.ok(await fsp.stat(foreign), 'their session kept')
  })
})

test('attachments split by creation time', async () => {
  await withHome(async (home) => {
    const dir = path.join(home, 'attachments')
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'old'), 'x'.repeat(50))
    await sleep(20)

    const harness = await boot(home)
    await fsp.writeFile(path.join(dir, 'new'), 'y'.repeat(20))

    const wipe = await tool(harness).execute({ action: 'wipe', confirm: true }, {})
    assert.equal(wipe.ok, true)
    assert.ok(await fsp.stat(path.join(dir, 'old')), 'old attachment kept')
    await assert.rejects(fsp.stat(path.join(dir, 'new')), 'new attachment deleted')
  })
})

test('a non-empty refs section that cannot be parsed is reported', async () => {
  await withHome(async (home) => {
    await fsp.writeFile(
      path.join(home, '.credentials.yaml'),
      'version: 1\nrecords:\nrefs:\n  - DEEPSEEK_API_KEY: sk-test\n',
    )
    const harness = await boot(home)
    const audit = await tool(harness).execute({ action: 'audit' }, {})
    assert.ok(audit.findings.some((item) => item.id === 'credential-unparsed'), 'unparsed refs reported')
  })
})

test('inline and block refs are both discovered', async () => {
  const shapes = [
    'version: 1\nrefs: { DEEPSEEK_API_KEY: sk-abc }\n',
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-abc\n',
  ]
  for (const content of shapes) {
    await withHome(async (home) => {
      await fsp.writeFile(path.join(home, '.credentials.yaml'), content)
      const harness = await boot(home, { store: new Map([['DEEPSEEK_API_KEY', 'sk-abc']]) })
      const audit = await tool(harness).execute({ action: 'audit' }, {})
      assert.ok(audit.findings.some((item) => item.id === 'api-key-foreign'), 'stored key reported')
      assert.ok(!audit.findings.some((item) => item.id === 'credential-unparsed'), 'no false warning')
    })
  }
})

test('a wipe clears only the credentials written during the borrow', async () => {
  await withHome(async (home) => {
    await fsp.writeFile(
      path.join(home, '.credentials.yaml'),
      'version: 1\nrefs: { DEEPSEEK_API_KEY: sk-mine, OTHER_KEY: sk-theirs }\n',
    )
    const store = new Map([['DEEPSEEK_API_KEY', 'sk-mine'], ['OTHER_KEY', 'sk-theirs']])
    const harness = await boot(home, { store })
    harness.ctx.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY')
    await sleep(40)

    const wipe = await tool(harness).execute({ action: 'wipe', confirm: true }, {})
    assert.equal(wipe.ok, true)
    assert.equal(store.has('DEEPSEEK_API_KEY'), false, 'my key cleared')
    assert.equal(store.get('OTHER_KEY'), 'sk-theirs', 'their key kept')
  })
})

test('a wipe removes only workspaces opened during the borrow', async () => {
  await withHome(async (home) => {
    const workspaces = new Map([['ws-foreign', { id: 'ws-foreign', title: 'theirs' }]])
    const harness = await boot(home, { workspaces })
    await sleep(60)
    workspaces.set('ws-mine', { id: 'ws-mine', title: 'mine' })

    const audit = await tool(harness).execute({ action: 'audit' }, {})
    assert.ok(audit.findings.some((item) => item.id === 'workspaces' && item.scope === 'mine'), 'my workspace listed')

    const wipe = await tool(harness).execute({ action: 'wipe', confirm: true }, {})
    assert.equal(wipe.ok, true)
    assert.equal(workspaces.has('ws-mine'), false, 'my workspace removed')
    assert.equal(workspaces.has('ws-foreign'), true, 'their workspace kept')
  })
})

test('includeUnattributed widens the wipe to the whole machine', async () => {
  await withHome(async (home) => {
    const foreign = path.join(home, 'sessions', '--work--', 'session-foreign')
    await fsp.mkdir(foreign, { recursive: true })
    await fsp.writeFile(path.join(foreign, 'session.v4.jsonl.zstd'), 'x'.repeat(100))
    await sleep(20)

    const harness = await boot(home)
    const wipe = await tool(harness).execute({ action: 'wipe', confirm: true, includeUnattributed: true }, {})
    assert.equal(wipe.ok, true)
    await assert.rejects(fsp.stat(foreign), 'foreign session deleted by the explicit escape hatch')
  })
})

let failed = 0
for (const entry of cases) {
  try {
    await entry.fn()
    console.log(`ok   ${entry.name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${entry.name}`)
    console.error(error)
  }
}
if (failed > 0) {
  console.error(`\n${failed} of ${cases.length} test(s) failed`)
  process.exit(1)
}
console.log(`\n${cases.length} test(s) passed`)
