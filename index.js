/**
 * Borrowed Device Guard — Host half.
 *
 * DSH normally persists the API key, the whole conversation log, attachments
 * and caches under `$DSH_HOME`. On a machine that is not yours (company shared
 * PC, internet cafe, a friend's laptop) that is exactly the data you cannot
 * leave behind — but the machine may already hold the owner's own DSH data,
 * which must never be touched.
 *
 * Ownership is therefore tracked, not guessed:
 *  - a session belongs to the borrow only when this plugin saw it being
 *    created while armed (`session/created`);
 *  - a credential belongs to the borrow only when this plugin saw it being
 *    written while armed (`credentials/reference-updated` / `record-updated`);
 *  - anonymous files (attachments, caches, temp output) belong to the borrow
 *    only when they were created after this process started.
 * Everything else is reported as somebody else's and is left alone. A wipe
 * defaults to owned items only; `includeUnattributed` is the explicit escape
 * hatch for a machine that really is fresh.
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'borrowed-device'
export const inject = ['tools', 'commands', 'systemPrompt', 'webServer', 'credentials', 'connection']

const STATE_FILE = '.borrowed-device.json'
const SECTION_NAME = 'borrowed-device'
const SECTION_ORDER = 860
const API_PREFIX = '/borrowed/api/'
const DEFAULT_REFS = ['DEEPSEEK_API_KEY']
const SELFTEST_REF = 'BORROWED_DEVICE_SELFTEST'
const TEMP_PATTERN = /^dsh-(spill|subprocess|workspace-changes|inspect)/
const MAX_WALK = 20000
const MAX_OWNED = 2000

const SECTION_TEXT = [
  'This machine is MARKED as a borrowed / public computer (borrowed-device mode is armed).',
  'Never write credentials, tokens, cookies or personal data into files here, never print an API key or a full token into a command or a message, and prefer reading the minimum amount of private data needed for the task.',
  'The machine may also hold data that belongs to its owner: do not delete or overwrite files outside the task, and when the user seems to be finishing, remind them in one short sentence to run the borrowed-device cleanup (the bar above the composer, or the `borrowed_device` tool with action `wipe`).',
].join(' ')

/** Normalized plugin config (the row carries `config:` only when the user tunes it). */
function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const refs = Array.isArray(config.refs)
    ? config.refs.filter((ref) => typeof ref === 'string' && ref.length > 0)
    : DEFAULT_REFS
  return {
    autoArmOnNewMachine: config.autoArmOnNewMachine !== false,
    shellHistoryOnWipe: config.shellHistoryOnWipe === true,
    refs: refs.length > 0 ? refs : DEFAULT_REFS,
  }
}

function homeDir() {
  const home = process.env.DSH_HOME
  return home && home.length > 0 ? home : path.join(os.homedir(), '.dsh')
}

function statePath() {
  return path.join(homeDir(), STATE_FILE)
}

function credentialsPath() {
  return path.join(homeDir(), '.credentials.yaml')
}

function machineId() {
  const raw = [os.hostname(), os.platform(), os.userInfo().username].join('|')
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** True when `target` resolves inside one of the roots this plugin may delete. */
function isSafeTarget(target) {
  let resolved
  try {
    resolved = path.resolve(target)
  } catch {
    return false
  }
  const home = path.resolve(homeDir())
  if (resolved === home) return false
  return resolved.startsWith(home + path.sep)
}

async function removeTarget(target) {
  if (!isSafeTarget(target)) return { ok: false, reason: 'refused: outside DSH-owned paths' }
  try {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error && error.code ? String(error.code) : String(error) }
  }
}

async function readdirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function dirStats(root, budget = MAX_WALK, deadline = Infinity) {
  const result = { files: 0, bytes: 0 }
  const stack = [root]
  let visited = 0
  while (stack.length > 0 && visited < budget && Date.now() < deadline) {
    const dir = stack.pop()
    for (const entry of await readdirSafe(dir)) {
      visited += 1
      if (visited >= budget) break
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(target)
      } else if (entry.isFile()) {
        try {
          const stat = await fsp.stat(target)
          result.files += 1
          result.bytes += stat.size
        } catch {
          /* vanished */
        }
      }
    }
  }
  return result
}

async function fileStats(target) {
  try {
    const stat = await fsp.stat(target)
    return stat.isFile() ? { files: 1, bytes: stat.size } : { files: 0, bytes: 0 }
  } catch {
    return { files: 0, bytes: 0 }
  }
}

/** Creation time in ms, falling back to mtime where birthtime is unavailable. */
function createdMs(stat) {
  const birth = Number(stat.birthtimeMs) || 0
  return birth > 0 ? birth : Number(stat.mtimeMs) || 0
}

/**
 * Read the reference names out of `.credentials.yaml` without touching values.
 * The store writes `refs` either as an inline map (`refs: { KEY: value }`) or
 * as a block of indented keys, so both shapes are handled.
 */
function parseRefNames(text) {
  const names = []
  let mode = null
  for (const line of text.split(/\r?\n/)) {
    const head = /^refs:\s*(.*)$/.exec(line)
    if (head) {
      const rest = head[1].trim()
      if (rest.startsWith('{')) {
        for (const part of rest.replace(/^\{/, '').replace(/\}$/, '').split(',')) {
          const key = part.split(':')[0]
          if (key && key.trim()) names.push(key.trim().replace(/^['"]|['"]$/g, ''))
        }
        mode = null
      } else {
        mode = 'refs'
      }
      continue
    }
    if (mode === 'refs') {
      if (/^\S/.test(line)) {
        mode = null
        continue
      }
      const key = /^\s+([A-Za-z0-9_]+)\s*:/.exec(line)
      if (key) names.push(key[1])
    }
  }
  return names
}

async function discoverRefs(config) {
  const names = new Set(config.refs)
  try {
    const text = await fsp.readFile(credentialsPath(), 'utf8')
    for (const name of parseRefNames(text)) names.add(name)
  } catch {
    /* no credential file yet */
  }
  return [...names].filter((ref) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(ref))
}

/**
 * How much of the `refs` section this version can actually read. A populated
 * section that yields zero names means the store changed shape under us and a
 * key could silently survive a cleanup, so the audit reports it instead of
 * pretending there was nothing to delete.
 */
function inspectCredsSection(text) {
  const lines = text.split(/\r?\n/)
  let found = false
  let populated = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/^refs:/.test(line)) continue
    found = true
    const rest = line.slice('refs:'.length).trim()
    if (rest.startsWith('{')) {
      const body = rest.replace(/^\{/, '').replace(/\}.*$/, '')
      populated = body.replace(/[\s,]/g, '') !== ''
    } else {
      for (let next = index + 1; next < lines.length; next += 1) {
        const row = lines[next]
        if (/^\S/.test(row)) break
        if (row.trim() !== '') {
          populated = true
          break
        }
      }
    }
    break
  }
  return { found, populated, parsed: parseRefNames(text) }
}

async function credentialSnapshot(ctx, config) {
  const refs = await discoverRefs(config)
  const states = []
  for (const ref of refs) {
    try {
      const info = await ctx.credentials.describe(ref)
      states.push({
        ref,
        configured: info.configured === true,
        writable: info.writable === true,
        source: typeof info.source === 'string' ? info.source : '',
      })
    } catch {
      states.push({ ref, configured: false, writable: false, source: '' })
    }
  }
  let records = []
  try {
    records = [...(await ctx.credentials.listRecords())]
  } catch {
    records = []
  }
  const envSourced = (state) => /env/i.test(state.source)
  const onDisk = states.filter((state) => state.configured && !envSourced(state))
  return { refs, states, records, onDisk }
}

// ── Ownership inventory ─────────────────────────────────────────────────────

/** Cheap id-only listing, used by status polling. */
async function listSessionIds() {
  const root = path.join(homeDir(), 'sessions')
  const ids = []
  for (const cwdEntry of await readdirSafe(root)) {
    if (!cwdEntry.isDirectory()) continue
    for (const idEntry of await readdirSafe(path.join(root, cwdEntry.name))) {
      if (idEntry.isDirectory()) ids.push(idEntry.name)
    }
  }
  return ids
}

/** Every session directory with its size and its cwd-group directory. */
async function listSessionEntries() {
  const root = path.join(homeDir(), 'sessions')
  const entries = []
  for (const cwdEntry of await readdirSafe(root)) {
    if (!cwdEntry.isDirectory()) continue
    const cwdDir = path.join(root, cwdEntry.name)
    for (const idEntry of await readdirSafe(cwdDir)) {
      if (!idEntry.isDirectory()) continue
      const dir = path.join(cwdDir, idEntry.name)
      const stats = await dirStats(dir)
      entries.push({ id: idEntry.name, dir, cwdDir, files: stats.files, bytes: stats.bytes })
    }
  }
  return entries
}

async function listProjectionFiles() {
  const dir = path.join(homeDir(), 'storages', 'session_projcache', 'sessions')
  const files = []
  for (const entry of await readdirSafe(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const target = path.join(dir, entry.name)
    const stats = await fileStats(target)
    files.push({ id: entry.name.slice(0, -'.json'.length), path: target, bytes: stats.bytes })
  }
  return files
}

/**
 * The workspaces this machine currently knows about, or null when the registry
 * is absent (a stripped-down host). Workspace entries are only ever removed
 * against a baseline captured before the borrow, never inferred.
 */
async function readWorkspaces(ctx) {
  try {
    const registry = ctx.get?.('workspaceRegistry')
    if (!registry || typeof registry.list !== 'function') return null
    return registry.list().map((entry) => ({
      id: String(entry.id),
      title: typeof entry.title === 'string' ? entry.title : '',
    }))
  } catch {
    return null
  }
}

/**
 * Walk a content-addressed directory and split files by creation time. Files
 * created before this process started belong to whoever used the machine
 * before the borrow.
 */
async function scanAnonymous(root, since, budget = MAX_WALK, deadline = Infinity) {
  const result = { mine: [], mineFiles: 0, mineBytes: 0, foreignFiles: 0, foreignBytes: 0, truncated: false }
  const stack = [root]
  let visited = 0
  while (stack.length > 0 && visited < budget && Date.now() < deadline) {
    const dir = stack.pop()
    for (const entry of await readdirSafe(dir)) {
      visited += 1
      if (visited >= budget) break
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(target)
        continue
      }
      if (!entry.isFile()) continue
      let stat
      try {
        stat = await fsp.stat(target)
      } catch {
        continue
      }
      if (createdMs(stat) >= since) {
        result.mine.push(target)
        result.mineFiles += 1
        result.mineBytes += stat.size
      } else {
        result.foreignFiles += 1
        result.foreignBytes += stat.size
      }
    }
  }
  result.truncated = stack.length > 0 || visited >= budget
  return result
}

function levelRank(level) {
  return { critical: 0, high: 1, medium: 2, low: 3, info: 4 }[level] ?? 9
}

function finding(entry) {
  return {
    bytes: 0,
    files: 0,
    wipeable: false,
    ...entry,
  }
}

async function performAudit(ctx, config, options = {}) {
  const since = options.since ?? Date.now()
  const deadline = Date.now() + 2500
  const snapshot = options.snapshot
  const ownedSessions = new Set(snapshot.ownedSessions)
  const ownedRefs = new Set(snapshot.ownedRefs)
  const ownedRecords = new Set(snapshot.ownedRecords)
  const findings = []
  const home = homeDir()

  // Credentials ─────────────────────────────────────────────────────────────
  const cred = await credentialSnapshot(ctx, config)
  const credFile = await fileStats(credentialsPath())
  const credText = await fsp.readFile(credentialsPath(), 'utf8').catch(() => '')
  const credSection = inspectCredsSection(credText)
  if (credSection.found && credSection.populated && credSection.parsed.length === 0) {
    findings.push(finding({
      id: 'credential-unparsed',
      scope: 'shared',
      level: 'high',
      title: 'Credential entries this version cannot interpret',
      detail: `${credentialsPath()} has a non-empty refs section this plugin could not read, so a stored key may survive the cleanup. Check that file by hand before leaving.`,
      bytes: credFile.bytes,
      files: credFile.files,
      wipeable: false,
    }))
  }
  const mineRefs = cred.onDisk.filter((state) => ownedRefs.has(state.ref))
  const foreignRefs = cred.onDisk.filter((state) => !ownedRefs.has(state.ref))
  if (mineRefs.length > 0) {
    findings.push(finding({
      id: 'api-key',
      scope: 'mine',
      level: 'critical',
      title: 'Your API key is stored on this disk',
      detail: `${mineRefs.map((state) => state.ref).join(', ')} — ${credentialsPath()}`,
      bytes: credFile.bytes,
      files: credFile.files,
      wipeable: true,
    }))
  }
  if (foreignRefs.length > 0) {
    findings.push(finding({
      id: 'api-key-foreign',
      scope: 'foreign',
      level: 'info',
      title: 'A stored key that was not written during this borrow',
      detail: `${foreignRefs.map((state) => state.ref).join(', ')} already existed here, so it belongs to whoever set it up. Left untouched.`,
      wipeable: false,
    }))
  }
  const mineRecords = cred.records.filter((record) => ownedRecords.has(String(record.key)))
  const foreignRecords = cred.records.filter((record) => !ownedRecords.has(String(record.key)))
  if (mineRecords.length > 0) {
    findings.push(finding({
      id: 'credential-records',
      scope: 'mine',
      level: 'critical',
      title: `${mineRecords.length} credential record(s) created during this borrow`,
      detail: mineRecords.map((record) => `${record.key} (${record.kind})`).join(', '),
      bytes: credFile.bytes,
      files: credFile.files,
      wipeable: true,
    }))
  }
  if (foreignRecords.length > 0) {
    findings.push(finding({
      id: 'credential-records-foreign',
      scope: 'foreign',
      level: 'info',
      title: `${foreignRecords.length} credential record(s) from before this borrow`,
      detail: foreignRecords.map((record) => `${record.key} (${record.kind})`).join(', '),
      wipeable: false,
    }))
  }

  // Sessions ────────────────────────────────────────────────────────────────
  const sessions = await listSessionEntries()
  const mineSessions = sessions.filter((entry) => ownedSessions.has(entry.id))
  const foreignSessions = sessions.filter((entry) => !ownedSessions.has(entry.id))
  if (mineSessions.length > 0) {
    const bytes = mineSessions.reduce((sum, entry) => sum + entry.bytes, 0)
    findings.push(finding({
      id: 'sessions',
      scope: 'mine',
      level: 'high',
      title: 'Your conversation logs',
      detail: `${mineSessions.length} session(s), ${formatBytes(bytes)} — ${path.join(home, 'sessions')}`,
      bytes,
      files: mineSessions.reduce((sum, entry) => sum + entry.files, 0),
      wipeable: true,
    }))
  }
  if (foreignSessions.length > 0) {
    const bytes = foreignSessions.reduce((sum, entry) => sum + entry.bytes, 0)
    findings.push(finding({
      id: 'sessions-foreign',
      scope: 'foreign',
      level: 'info',
      title: `${foreignSessions.length} conversation log(s) from other people`,
      detail: `${formatBytes(bytes)} created before this borrow — not yours, so the cleanup leaves them alone.`,
      bytes,
      files: foreignSessions.reduce((sum, entry) => sum + entry.files, 0),
      wipeable: false,
    }))
  }

  // Projection cache is keyed by session id, so it splits exactly like sessions.
  const projections = await listProjectionFiles()
  const mineProjections = projections.filter((entry) => ownedSessions.has(entry.id))
  const foreignProjections = projections.filter((entry) => !ownedSessions.has(entry.id))
  if (mineProjections.length > 0) {
    const bytes = mineProjections.reduce((sum, entry) => sum + entry.bytes, 0)
    findings.push(finding({
      id: 'projections',
      scope: 'mine',
      level: 'medium',
      title: 'Your session projection cache',
      detail: `${mineProjections.length} file(s), ${formatBytes(bytes)}`,
      bytes,
      files: mineProjections.length,
      wipeable: true,
    }))
  }
  if (foreignProjections.length > 0) {
    findings.push(finding({
      id: 'projections-foreign',
      scope: 'foreign',
      level: 'info',
      title: `${foreignProjections.length} projection cache file(s) from other people`,
      detail: 'Keyed by their session ids; left untouched.',
      wipeable: false,
    }))
  }

  // Anonymous content-addressed stores split by creation time.
  for (const item of [
    { id: 'attachments', title: 'Your attachments (images and files)', target: path.join(home, 'attachments'), level: 'high' },
    { id: 'cache', title: 'Cache from this borrow', target: path.join(home, 'cache'), level: 'medium' },
  ]) {
    const scan = await scanAnonymous(item.target, since, MAX_WALK, deadline)
    if (scan.mineFiles > 0) {
      findings.push(finding({
        id: item.id,
        scope: 'mine',
        level: item.level,
        title: item.title,
        detail: `${scan.mineFiles} file(s), ${formatBytes(scan.mineBytes)} — ${item.target}`,
        bytes: scan.mineBytes,
        files: scan.mineFiles,
        wipeable: true,
      }))
    }
    if (scan.foreignFiles > 0) {
      findings.push(finding({
        id: `${item.id}-foreign`,
        scope: 'foreign',
        level: 'info',
        title: `${scan.foreignFiles} ${item.id} file(s) from before this borrow`,
        detail: `${formatBytes(scan.foreignBytes)} — left untouched.`,
        bytes: scan.foreignBytes,
        files: scan.foreignFiles,
        wipeable: false,
      }))
    }
  }

  // Workspaces the borrow created are removable by id, against a baseline
  // captured before the borrow — never inferred from what is there now.
  const workspaces = await readWorkspaces(ctx)
  if (workspaces !== null && snapshot.workspaceBaselineAt !== null) {
    const baseline = new Set(snapshot.workspaceBaseline || [])
    const mine = workspaces.filter((workspace) => !baseline.has(workspace.id))
    if (mine.length > 0) {
      findings.push(finding({
        id: 'workspaces',
        scope: 'mine',
        level: 'low',
        title: 'Workspaces you opened',
        detail: `${mine.length} entr(y/ies): ${mine.map((workspace) => workspace.title || workspace.id).join(', ')}`,
        files: mine.length,
        wipeable: true,
      }))
    }
  }

  // Workspace index is a single shared registry: never edited, only reported.
  const workspaceIndex = path.join(home, 'storages', 'workspace.json')
  const workspaceStats = await fileStats(workspaceIndex)
  if (workspaceStats.files > 0) {
    findings.push(finding({
      id: 'workspace-index',
      scope: 'shared',
      level: 'low',
      title: 'Shared workspace index (project paths)',
      detail: `${workspaceIndex} — entries this borrow created are removed by id; the machine owner's stay.`,
      bytes: workspaceStats.bytes,
      files: workspaceStats.files,
      wipeable: false,
    }))
  }

  const temp = await collectTempArtifacts()
  const mineTemp = temp.filter((item) => item.createdMs >= since)
  const foreignTemp = temp.filter((item) => item.createdMs < since)
  if (mineTemp.length > 0) {
    findings.push(finding({
      id: 'temp',
      scope: 'mine',
      level: 'medium',
      title: 'Temporary tool output from this borrow',
      detail: `${mineTemp.length} dsh-* entr(y/ies) in ${os.tmpdir()}`,
      bytes: mineTemp.reduce((sum, item) => sum + item.bytes, 0),
      files: mineTemp.length,
      wipeable: true,
    }))
  }
  if (foreignTemp.length > 0) {
    findings.push(finding({
      id: 'temp-foreign',
      scope: 'foreign',
      level: 'info',
      title: `${foreignTemp.length} temporary dsh-* entr(y/ies) from before this borrow`,
      detail: 'Left untouched.',
      bytes: foreignTemp.reduce((sum, item) => sum + item.bytes, 0),
      files: foreignTemp.length,
      wipeable: false,
    }))
  }

  const shell = await collectShellArtifacts()
  if (shell.length > 0) {
    findings.push(finding({
      id: 'shell-history',
      scope: 'shared',
      level: 'high',
      title: 'Shell and git history may contain secrets',
      detail: shell.map((item) => item.path).join(', '),
      bytes: shell.reduce((sum, item) => sum + item.bytes, 0),
      files: shell.length,
      wipeable: config.shellHistoryOnWipe,
    }))
  }

  findings.push(finding({
    id: 'browser',
    scope: 'shared',
    level: 'info',
    title: 'Browser side data is outside DSH',
    detail: 'History, downloads and site storage belong to the browser on this machine — clear them from the browser before you leave.',
    wipeable: false,
  }))

  findings.sort((left, right) => levelRank(left.level) - levelRank(right.level))
  return findings
}

function summarizeFindings(findings) {
  const mine = findings.filter((item) => item.scope === 'mine')
  const foreign = findings.filter((item) => item.scope === 'foreign')
  const bytes = mine.reduce((sum, item) => sum + (item.bytes || 0), 0)
  const risky = mine.filter((item) => item.level === 'critical' || item.level === 'high' || item.level === 'medium')
  const parts = []
  if (risky.length > 0) {
    const counts = new Map()
    for (const item of risky) counts.set(item.level, (counts.get(item.level) || 0) + 1)
    parts.push(['critical', 'high', 'medium']
      .filter((level) => counts.has(level))
      .map((level) => `${counts.get(level)} ${level}`)
      .join(', '))
    parts.push(`yours: ${formatBytes(bytes)}`)
  } else {
    parts.push('nothing of yours left here')
  }
  if (foreign.length > 0) parts.push(`${foreign.length} kind(s) of other people's data are left untouched`)
  return `${parts.join(' · ')}.`
}

async function collectTempArtifacts() {
  const dir = os.tmpdir()
  const items = []
  for (const entry of await readdirSafe(dir)) {
    if (!TEMP_PATTERN.test(entry.name)) continue
    const target = path.join(dir, entry.name)
    const stats = entry.isDirectory() ? await dirStats(target) : await fileStats(target)
    let created = 0
    try {
      created = createdMs(await fsp.stat(target))
    } catch {
      /* ignore */
    }
    items.push({ path: target, bytes: stats.bytes, files: stats.files, createdMs: created })
  }
  return items
}

async function collectShellArtifacts() {
  const candidates = [
    path.join(os.homedir(), '.bash_history'),
    path.join(os.homedir(), '.zsh_history'),
    path.join(os.homedir(), '.git-credentials'),
  ]
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'PowerShell', 'PSReadLine', 'ConsoleHost_history.txt'))
  }
  const items = []
  for (const candidate of candidates) {
    const stats = await fileStats(candidate)
    if (stats.files > 0) items.push({ path: candidate, bytes: stats.bytes })
  }
  return items
}

// ── Wipe ────────────────────────────────────────────────────────────────────

/**
 * Delete only what this borrow produced. `all: true` (the explicit escape
 * hatch) widens the scope to every DSH-owned path on the machine.
 */
async function performWipe(ctx, config, options) {
  const includeAll = options.all === true
  const pendingPaths = []
  const removed = []
  const cleared = []
  const failed = []

  const snapshot = options.snapshot
  const ownedSessions = new Set(snapshot.ownedSessions)
  const ownedRefs = new Set(snapshot.ownedRefs)
  const ownedRecords = new Set(snapshot.ownedRecords)
  const since = options.since ?? Date.now()
  const wipeDeadline = Date.now() + 5000
  const home = homeDir()

  const removedSessionIds = new Set()
  const cwdDirs = new Set()

  // Sessions and their projections ─────────────────────────────────────────
  const sessions = await listSessionEntries()
  for (const entry of sessions) {
    cwdDirs.add(entry.cwdDir)
    if (!includeAll && !ownedSessions.has(entry.id)) continue
    const outcome = await removeTarget(entry.dir)
    if (outcome.ok) {
      removed.push(entry.dir)
      removedSessionIds.add(entry.id)
    } else {
      failed.push(`${entry.dir} (${outcome.reason})`)
      pendingPaths.push(entry.dir)
    }
  }
  for (const cwdDir of cwdDirs) {
    try {
      await fsp.rmdir(cwdDir)
    } catch {
      /* still holds other sessions */
    }
  }

  const projections = await listProjectionFiles()
  for (const entry of projections) {
    if (!includeAll && !ownedSessions.has(entry.id)) continue
    const outcome = await removeTarget(entry.path)
    if (outcome.ok) removed.push(entry.path)
    else failed.push(`${entry.path} (${outcome.reason})`)
  }

  // Workspace entries this borrow created, removed by id. Skipped entirely
  // unless a baseline was captured while armed, so a missing baseline can
  // never turn into "delete everything".
  if (!includeAll && snapshot.workspaceBaselineAt !== null) {
    const workspaces = await readWorkspaces(ctx)
    const registry = ctx.get?.('workspaceRegistry')
    if (workspaces !== null && registry && typeof registry.delete === 'function') {
      const baseline = new Set(snapshot.workspaceBaseline || [])
      for (const workspace of workspaces) {
        if (baseline.has(workspace.id)) continue
        try {
          await registry.delete(workspace.id)
          removed.push(`workspace:${workspace.id}`)
        } catch (error) {
          failed.push(`workspace:${workspace.id} (${error instanceof Error ? error.message : String(error)})`)
        }
      }
    }
  }

  // Anonymous stores ───────────────────────────────────────────────────────
  for (const item of [
    { id: 'attachments', target: path.join(home, 'attachments') },
    { id: 'cache', target: path.join(home, 'cache') },
  ]) {
    if (includeAll) {
      const outcome = await removeTarget(item.target)
      if (outcome.ok) removed.push(item.target)
      else {
        failed.push(`${item.target} (${outcome.reason})`)
        pendingPaths.push(item.target)
      }
      continue
    }
    const scan = await scanAnonymous(item.target, since, MAX_WALK, wipeDeadline)
    for (const target of scan.mine) {
      const outcome = await removeTarget(target)
      if (outcome.ok) removed.push(target)
      else {
        failed.push(`${target} (${outcome.reason})`)
        pendingPaths.push(target)
      }
    }
  }

  // Temporary output: only this borrow's, and only once it has gone idle so a
  // live tool result is not pulled out from under the running session.
  const cutoff = Date.now() - 30 * 60 * 1000
  for (const item of await collectTempArtifacts()) {
    if (!includeAll) {
      if (item.createdMs < since) continue
      if (item.createdMs > cutoff) continue
    }
    const outcome = await removeTarget(item.path)
    if (outcome.ok) removed.push(item.path)
    else {
      failed.push(`${item.path} (${outcome.reason})`)
      pendingPaths.push(item.path)
    }
  }

  if (includeAll) {
    const outcome = await removeTarget(path.join(home, 'storages', 'session_projcache'))
    if (outcome.ok) removed.push(path.join(home, 'storages', 'session_projcache'))
    const workspaceIndex = path.join(home, 'storages', 'workspace.json')
    const workspaceStats = await fileStats(workspaceIndex)
    if (workspaceStats.files > 0) {
      const workspaceOutcome = await removeTarget(workspaceIndex)
      if (workspaceOutcome.ok) removed.push(workspaceIndex)
    }
  }

  if (config.shellHistoryOnWipe === true) {
    for (const item of await collectShellArtifacts()) {
      const outcome = await removeTarget(item.path)
      if (outcome.ok) removed.push(item.path)
      else {
        failed.push(`${item.path} (${outcome.reason})`)
        pendingPaths.push(item.path)
      }
    }
  }

  // Credentials last: removing them ends model access for this session.
  const cred = await credentialSnapshot(ctx, config)
  for (const state of cred.states) {
    if (!includeAll && !ownedRefs.has(state.ref)) continue
    if (!state.configured) continue
    if (!state.writable) {
      failed.push(`${state.ref}: credential store is not writable`)
      continue
    }
    try {
      await ctx.credentials.unset(state.ref)
      cleared.push(state.ref)
    } catch (error) {
      failed.push(`${state.ref}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const record of cred.records) {
    if (!includeAll && !ownedRecords.has(String(record.key))) continue
    try {
      await ctx.credentials.deleteRecord(record.key)
      cleared.push(String(record.key))
    } catch (error) {
      failed.push(`${record.key}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Keep ownership of exactly what survived, so a second cleanup still works.
  snapshot.ownedSessions = snapshot.ownedSessions.filter((id) => !removedSessionIds.has(id))
  snapshot.ownedRefs = snapshot.ownedRefs.filter((ref) => !cleared.includes(ref))
  snapshot.ownedRecords = snapshot.ownedRecords.filter((key) => !cleared.includes(key))

  if (snapshot.workspaceBaselineAt !== null) {
    const left = await readWorkspaces(ctx)
    if (left !== null) snapshot.workspaceBaseline = left.map((workspace) => workspace.id)
  }

  const remaining = await performAudit(ctx, config, { since, snapshot })
  const leftovers = remaining.filter((item) => item.scope === 'mine'
    && (item.level === 'critical' || item.level === 'high'))

  const summaryParts = []
  summaryParts.push(removed.length + cleared.length > 0
    ? `Removed ${removed.length} item(s) of yours and cleared ${cleared.length} credential(s).`
    : 'Nothing of yours needed removing.')
  if (failed.length > 0) summaryParts.push(`${failed.length} item(s) could not be removed.`)
  if (leftovers.length > 0) {
    summaryParts.push('Still present: ' + leftovers.map((item) => item.title).join('; ') + '.')
    summaryParts.push('Close DSH and run the cleanup once more to remove files a running session still holds.')
  }

  return {
    removed,
    cleared,
    failed,
    remaining,
    summary: summaryParts.join(' '),
    pending: pendingPaths,
  }
}

/**
 * Probe one runtime fact with a throwaway reference: does this build keep a
 * credential resolvable after its only on-disk copy is removed?
 *
 * It cannot, on 0.2.x: `dsh-credentials-local` resolves the ambient layer from
 * the immutable launch snapshot, so a runtime `process.env` write is never
 * seen. The probe exists so a future build that changes this is detected
 * instead of guessed at, and so the plugin never ships a button that silently
 * rolls back. Nothing here reads or writes the user's real key.
 */
async function probeMemoryFallback(ctx) {
  const secret = 'probe-' + createHash('sha256')
    .update(`${Date.now()}:${Math.random()}`)
    .digest('hex')
    .slice(0, 24)
  try {
    try {
      await ctx.credentials.set(SELFTEST_REF, secret)
    } catch {
      return { ok: false, reason: 'store-not-writable' }
    }
    const stored = await ctx.credentials.resolve(SELFTEST_REF)
    if (!stored || stored.value !== secret) return { ok: false, reason: 'store-roundtrip-failed' }
    process.env[SELFTEST_REF] = secret
    await ctx.credentials.unset(SELFTEST_REF)
    const after = await ctx.credentials.describe(SELFTEST_REF)
    const resolved = after.configured ? await ctx.credentials.resolve(SELFTEST_REF) : undefined
    const ok = Boolean(resolved && resolved.value === secret)
    return {
      ok,
      reason: ok ? 'ok' : 'environment-fallback-unavailable',
      source: String(after.source || ''),
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  } finally {
    delete process.env[SELFTEST_REF]
    try {
      await ctx.credentials.unset(SELFTEST_REF)
    } catch {
      /* nothing left to clean */
    }
  }
}

// ── Shape of the tool result ────────────────────────────────────────────────

function toolOutputSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean', description: 'Whether the action completed.' },
      action: { type: 'string', description: 'The action that ran.' },
      summary: { type: 'string', description: 'One-line human-readable outcome.' },
      armed: { type: 'boolean', description: 'Borrowed-device mode state.' },
      trusted: { type: 'boolean', description: 'Whether this machine was marked as the user\'s own.' },
      machine: { type: 'string', description: 'Short machine id the state was recorded for.' },
      keyOnDisk: { type: 'boolean', description: 'Whether an API key is stored in the local credential file.' },
      keyInMemory: { type: 'boolean', description: 'Whether the key now comes from the process environment instead of the file.' },
      probeFailed: { type: 'boolean', description: 'Whether the runtime self-test failed.' },
      records: { type: 'number', description: 'Stored credential records on this machine.' },
      foreign: { type: 'number', description: 'Sessions on this machine that belong to somebody else.' },
      lastWipeAt: { type: 'string', description: 'ISO timestamp of the last cleanup, empty when never run.' },
      pending: { type: 'number', description: 'Paths a previous cleanup could not delete and will retry on next launch.' },
      apiHits: { type: 'number', description: 'Requests the web page has made to this plugin since the host started.' },
      findings: {
        type: 'array',
        description: 'Every trace found by an audit, most severe first.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            scope: { type: 'string', enum: ['mine', 'foreign', 'shared'] },
            level: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
            title: { type: 'string' },
            detail: { type: 'string' },
            bytes: { type: 'number' },
            files: { type: 'number' },
            wipeable: { type: 'boolean' },
          },
          required: ['id', 'scope', 'level', 'title', 'detail'],
        },
      },
      removed: { type: 'array', items: { type: 'string' }, description: 'Paths deleted by a wipe.' },
      cleared: { type: 'array', items: { type: 'string' }, description: 'Credential references removed by a wipe.' },
      failed: { type: 'array', items: { type: 'string' }, description: 'Items that could not be removed.' },
      detail: { type: 'string', description: 'Extra detail for the action.' },
    },
    required: ['ok', 'action', 'summary'],
  }
}

function renderToolOutput(_args, value) {
  const lines = [String(value.summary || '')]
  for (const item of value.findings || []) {
    const owner = item.scope === 'mine' ? '' : ` [${item.scope}]`
    lines.push(`- [${item.level}${owner}] ${item.title}: ${item.detail}`)
  }
  for (const item of value.failed || []) lines.push(`! ${item}`)
  if (value.detail) lines.push(value.detail)
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }]
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const runStartedAt = Date.now()
  let state = null
  let promptDisposer = null
  let busy = false
  let apiHits = 0

  async function ensureState() {
    if (state) return state
    let loaded = null
    try {
      loaded = JSON.parse(await fsp.readFile(statePath(), 'utf8'))
    } catch {
      loaded = null
    }
    const id = machineId()
    const emptyOwned = () => ({
      ownedSessions: [],
      ownedRefs: [],
      ownedRecords: [],
      workspaceBaseline: null,
      workspaceBaselineAt: null,
    })
    if (!loaded || loaded.machineId !== id) {
      state = {
        version: 2,
        machineId: id,
        trusted: false,
        armed: config.autoArmOnNewMachine,
        firstSeenAt: Date.now(),
        armedAt: Date.now(),
        lastWipeAt: null,
        pendingWipe: [],
        ...emptyOwned(),
      }
      await writeState()
      return state
    }
    state = {
      version: 2,
      machineId: id,
      trusted: loaded.trusted === true,
      armed: loaded.armed === true || (config.autoArmOnNewMachine && loaded.trusted !== true),
      firstSeenAt: typeof loaded.firstSeenAt === 'number' ? loaded.firstSeenAt : Date.now(),
      armedAt: typeof loaded.armedAt === 'number' ? loaded.armedAt : Date.now(),
      lastWipeAt: typeof loaded.lastWipeAt === 'number' ? loaded.lastWipeAt : null,
      pendingWipe: Array.isArray(loaded.pendingWipe) ? loaded.pendingWipe.filter((item) => typeof item === 'string') : [],
      ownedSessions: (Array.isArray(loaded.ownedSessions) ? loaded.ownedSessions : []).slice(-MAX_OWNED),
      ownedRefs: (Array.isArray(loaded.ownedRefs) ? loaded.ownedRefs : []).filter((item) => typeof item === 'string'),
      ownedRecords: (Array.isArray(loaded.ownedRecords) ? loaded.ownedRecords : []).filter((item) => typeof item === 'string'),
      workspaceBaseline: Array.isArray(loaded.workspaceBaseline) ? loaded.workspaceBaseline.map(String) : null,
      workspaceBaselineAt: typeof loaded.workspaceBaselineAt === 'number' ? loaded.workspaceBaselineAt : null,
    }
    if (state.trusted) state.armed = false
    return state
  }

  async function writeState() {
    if (!state) return
    try {
      await fsp.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf8')
    } catch (error) {
      ctx.logger?.warn?.('borrowed-device: cannot persist state', error)
    }
  }

  function claim(list, value) {
    if (list.includes(value)) return false
    list.push(value)
    if (list.length > MAX_OWNED) list.splice(0, list.length - MAX_OWNED)
    return true
  }

  /**
   * Snapshot the workspace ids present when the borrow starts. Only entries
   * created after this point are treated as the guest's; without a baseline
   * the wipe leaves every workspace alone.
   */
  async function captureWorkspaceBaseline() {
    const current = await ensureState()
    if (current.armed !== true || current.workspaceBaselineAt !== null) return
    const workspaces = await readWorkspaces(ctx)
    if (workspaces === null) return
    current.workspaceBaseline = workspaces.map((workspace) => workspace.id)
    current.workspaceBaselineAt = Date.now()
    await writeState()
  }

  /**
   * Record ownership only for what happens while armed. The bookkeeping is
   * fire-and-forget: a failed write costs precision, never a deletion.
   */
  function observe(kind, collect) {
    return (value) => {
      void ensureState().then(async (current) => {
        if (current.armed !== true) return
        const changed = collect(current, value)
        if (changed) await writeState()
      }).catch(() => {})
    }
  }

  const onSessionCreated = observe('session', (current, session) => {
    const id = session && session.id ? String(session.id) : ''
    return id !== '' && claim(current.ownedSessions, id)
  })
  const onRefUpdated = observe('ref', (current, ref) => (String(ref) === SELFTEST_REF
    ? false
    : claim(current.ownedRefs, String(ref))))
  const onRecordUpdated = observe('record', (current, key) => claim(current.ownedRecords, String(key)))

  function syncPrompt() {
    const want = state !== null && state.armed === true
    if (want && promptDisposer === null) {
      promptDisposer = ctx.systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => SECTION_TEXT,
      })
    } else if (!want && promptDisposer !== null) {
      promptDisposer()
      promptDisposer = null
    }
  }

  async function statusPayload() {
    const current = await ensureState()
    const cred = await credentialSnapshot(ctx, config)
    const owned = new Set(current.ownedSessions)
    const ids = await listSessionIds()
    const foreign = ids.filter((id) => !owned.has(id)).length
    return {
      ok: true,
      action: 'status',
      armed: current.armed === true,
      trusted: current.trusted === true,
      machine: current.machineId,
      keyOnDisk: cred.onDisk.length > 0,
      keyInMemory: cred.states.some((state) => state.configured && /env/i.test(state.source)),
      records: cred.records.length,
      foreign,
      lastWipeAt: current.lastWipeAt ? new Date(current.lastWipeAt).toISOString() : '',
      pending: current.pendingWipe.length,
      apiHits,
      summary: current.armed
        ? 'Borrowed-device mode is armed on this machine.'
        : 'This machine is marked as your own; borrowed-device mode is off.',
    }
  }

  async function auditPayload() {
    const current = await ensureState()
    const findings = await performAudit(ctx, config, { since: runStartedAt, snapshot: current })
    return {
      ok: true,
      action: 'audit',
      armed: current.armed === true,
      trusted: current.trusted === true,
      machine: current.machineId,
      summary: summarizeFindings(findings),
      findings,
    }
  }

  async function perform(action, args = {}) {
    if (action === 'status') return statusPayload()
    if (action === 'audit') return auditPayload()
    if (action === 'arm' || action === 'trust') {
      const current = await ensureState()
      if (action === 'arm') {
        current.armed = true
        current.trusted = false
        current.armedAt = Date.now()
        current.workspaceBaseline = null
        current.workspaceBaselineAt = null
      } else {
        // Trusting must stay undoable: ownership bookkeeping is deliberately
        // kept, so re-arming restores exactly what this borrow produced.
        current.armed = false
        current.trusted = true
        current.workspaceBaseline = null
        current.workspaceBaselineAt = null
      }
      await writeState()
      if (action === 'arm') await captureWorkspaceBaseline()
      syncPrompt()
      return statusPayload()
    }
    if (action === 'selftest') {
      await ensureState()
      const probe = await probeMemoryFallback(ctx)
      const status = await statusPayload()
      return {
        ...status,
        action: 'selftest',
        probeFailed: !probe.ok,
        summary: probe.ok
          ? 'This build keeps a credential working after its disk copy is removed.'
          : 'This build cannot keep a credential working without a disk copy.',
        detail: `probe: ${probe.reason}${probe.source ? ` (${probe.source})` : ''}`,
      }
    }
    if (action === 'wipe') {
      if (args.confirm !== true) {
        return {
          ok: false,
          action: 'wipe',
          summary: 'Refused: wiping deletes the conversation logs, attachments, caches and credentials this borrow created. Call again with confirm=true after the user explicitly agreed.',
        }
      }
      if (busy) {
        return { ok: false, action: 'wipe', summary: 'Another cleanup is already running.' }
      }
      busy = true
      try {
        const current = await ensureState()
        await captureWorkspaceBaseline()
        const result = await performWipe(ctx, config, {
          all: args.includeUnattributed === true,
          since: runStartedAt,
          snapshot: current,
        })
        current.lastWipeAt = Date.now()
        current.pendingWipe = result.pending
        await writeState()
        return {
          ok: true,
          action: 'wipe',
          armed: current.armed === true,
          trusted: current.trusted === true,
          machine: current.machineId,
          summary: result.summary,
          findings: result.remaining,
          removed: result.removed,
          cleared: result.cleared,
          failed: result.failed,
        }
      } finally {
        busy = false
      }
    }
    return { ok: false, action: String(action), summary: `Unknown action "${action}".` }
  }

  // ── Tool ────────────────────────────────────────────────────────────────
  ctx.effect(() => ctx.tools.register({
    name: 'borrowed_device',
    description:
      'Inspect and clean the traces DSH leaves on a machine that is not the user\'s own (a company shared PC, an internet cafe, a borrowed laptop). '
      + 'The machine may also hold its owner\'s DSH data: this tool only ever deletes sessions and credentials created during this borrow and files created after the host started, and reports everything else as left untouched. '
      + 'Actions: `status`, `audit` (what is yours vs other people\'s), `selftest` (whether this runtime can keep a key usable without a disk copy), '
      + '`wipe` (delete your logs, attachments, caches and credentials; requires confirm=true and ends model access), `arm`, `trust`. '
      + 'Never print an API key or token into a message.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'audit', 'selftest', 'wipe', 'arm', 'trust'],
          description: 'What to do.',
        },
        confirm: {
          type: 'boolean',
          description: 'Required true for `wipe`; only after the user explicitly agreed to delete local data.',
        },
        includeUnattributed: {
          type: 'boolean',
          description: 'For `wipe`: also delete data created before this borrow (other people\'s). Only for a machine that is genuinely fresh.',
        },
        includeShellHistory: {
          type: 'boolean',
          description: 'For `wipe`: also delete the shell and git history files listed by the audit.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: toolOutputSchema(),
      render: renderToolOutput,
    },
    execute: async (args, exec) => {
      if (exec?.signal?.aborted) throw new Error('aborted')
      const action = String(args?.action || '')
      return perform(action, {
        confirm: args?.confirm === true,
        includeUnattributed: args?.includeUnattributed === true,
        includeShellHistory: args?.includeShellHistory === true,
        all: args?.includeUnattributed === true,
      })
    },
  }), 'borrowed-device: tool')

  // ── Slash command ───────────────────────────────────────────────────────
  ctx.effect(() => ctx.commands.register({
    name: 'borrowed',
    description: 'Borrowed-device mode: status | audit | wipe | on (re-arm) | trust',
    input: { hint: 'status | audit | wipe confirm | on | trust' },
    handler: async (invocation) => {
      const input = String(invocation.rawInput || '').trim().toLowerCase()
      const [head, ...rest] = input.split(/\s+/).filter(Boolean)
      const action = head || 'status'
      try {
        if (action === 'selftest' || action === 'check') {
          const result = await perform('selftest')
          return { kind: 'success', text: `${result.summary}\n${result.detail || ''}`.trim() }
        }
        if (action === 'wipe') {
          if (!rest.includes('confirm')) {
            const audit = await auditPayload()
            const preview = audit.findings.filter((item) => item.wipeable)
            return {
              kind: 'success',
              text: `This would delete:\n${preview.map((item) => `- ${item.title}: ${item.detail}`).join('\n')}\n\nEverything marked as other people's is left alone. Run \`/borrowed wipe confirm\` to delete, or \`/borrowed wipe confirm all\` to delete this machine's DSH data as well.`,
            }
          }
          const result = await perform('wipe', {
            confirm: true,
            includeUnattributed: rest.includes('all'),
            includeShellHistory: rest.includes('shell'),
          })
          const failed = result.failed && result.failed.length > 0
            ? `\nCould not remove:\n${result.failed.map((item) => `- ${item}`).join('\n')}`
            : ''
          return { kind: 'success', text: `${result.summary}${failed}` }
        }
        if (action === 'audit') {
          const result = await auditPayload()
          return {
            kind: 'success',
            text: `${result.summary}\n${result.findings.map((item) => `- [${item.level}/${item.scope}] ${item.title}: ${item.detail}`).join('\n')}`,
          }
        }
        if (action === 'trust' || action === 'off') {
          const result = await perform('trust')
          return { kind: 'success', text: `${result.summary} This machine is now trusted.` }
        }
        if (action === 'on' || action === 'arm') {
          const result = await perform('arm')
          return { kind: 'success', text: `${result.summary} Cleanup reminder is on.` }
        }
        const result = await perform(action === 'status' ? 'status' : action)
        return { kind: 'success', text: result.summary }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'borrowed-device: command')

  // ── Ownership observation ───────────────────────────────────────────────
  ctx.effect(() => ctx.on('session/created', onSessionCreated), 'borrowed-device: session ownership')
  ctx.effect(() => ctx.on('credentials/reference-updated', onRefUpdated), 'borrowed-device: credential ownership')
  ctx.effect(() => ctx.on('credentials/record-updated', onRecordUpdated), 'borrowed-device: record ownership')

  // ── Client HTTP API ─────────────────────────────────────────────────────
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/borrowed/api',
    handler: async (req, res) => {
      const reject = ctx.connection.requestRejection(req)
      if (reject !== undefined) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
        return
      }
      const pathname = new URL(req.url || '/', 'http://dsh.internal').pathname
      const method = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : ''
      const action = method === 'status' || method === 'audit' || method === 'wipe' || method === 'selftest'
        ? method
        : method === 'trust'
          ? 'trust'
          : method === 'arm'
            ? 'arm'
            : null
      if (action === null) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'unknown method' }))
        return
      }
      try {
        const args = await readJsonBody(req)
        apiHits += 1
        const result = await perform(action, {
          confirm: args?.confirm === true,
          includeUnattributed: args?.includeUnattributed === true,
          includeShellHistory: args?.includeShellHistory === true,
          all: args?.includeUnattributed === true,
        })
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(result))
      } catch (error) {
        ctx.logger?.warn?.('borrowed-device: api failure', error)
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      }
    },
  }), 'borrowed-device: /borrowed/api routes')

  // ── Boot: finish a wipe a running session could not complete last time ──
  void (async () => {
    try {
      const current = await ensureState()
      if (current.pendingWipe.length > 0) {
        const left = []
        for (const target of current.pendingWipe) {
          if (!isSafeTarget(target)) continue
          const outcome = await removeTarget(target)
          if (!outcome.ok) left.push(target)
        }
        current.pendingWipe = left
        await writeState()
      }
      await captureWorkspaceBaseline()
      syncPrompt()
    } catch (error) {
      ctx.logger?.warn?.('borrowed-device: boot task failed', error)
    }
  })()
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}
