/**
 * Host half of the plugin auto-updater.
 *
 * Periodically compares installed registry-backed bundles against npm `latest`
 * and applies newer releases. Applies the official DSH path when the in-place
 * install is refused (`already-installed`): uninstall the bundle, install the
 * new version, and restore the previous version if that second step fails.
 * Local (link/file/git) bundles, official on-demand bundles, management-required
 * bundles, and this plugin itself are never touched.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SELF_NAME = 'dsh-plugin-autoupdater'
const ROUTES = {
  state: '/dsh-auto-update/state',
  settings: '/dsh-auto-update/settings',
  run: '/dsh-auto-update/run',
}

const DEFAULT_CONFIG = {
  enabled: true,
  intervalMinutes: 360,
  autoApply: true,
  autoRemediate: true,
}

/** A failed package is not retried on the same target version for this long. */
const FAILURE_COOLDOWN_MS = 12 * 3600 * 1000
/** An automatic apply waits until the session log has been quiet for this long. */
const IDLE_WINDOW_MS = 5 * 60 * 1000
/** How long to wait after startup before the first automatic check. */
const FIRST_CHECK_DELAY_MS = 10 * 60 * 1000
/** How long to wait before retrying an automatic pass that arrived while busy. */
const DEFERRED_RETRY_MS = 10 * 60 * 1000

/** The DSH sessions directory holding per-workspace session logs. */
function sessionsRoot() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
}

/** Newest modification time among session log files, or 0 when unreadable. */
function newestSessionMtime() {
  let newest = 0
  try {
    for (const workspace of readdirSync(sessionsRoot(), { withFileTypes: true })) {
      if (!workspace.isDirectory()) continue
      const workspacePath = join(sessionsRoot(), workspace.name)
      let sessions
      try {
        sessions = readdirSync(workspacePath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const session of sessions) {
        if (!session.isDirectory()) continue
        const sessionPath = join(workspacePath, session.name)
        let files
        try {
          files = readdirSync(sessionPath, { withFileTypes: true })
        } catch {
          continue
        }
        for (const file of files) {
          if (!file.isFile()) continue
          try {
            newest = Math.max(newest, statSync(join(sessionPath, file.name)).mtimeMs)
          } catch {
            // A race with compaction: ignore this file.
          }
        }
      }
    }
  } catch {
    // No sessions directory yet: treat as idle.
  }
  return newest
}

/** Whether a conversation was active recently enough that applying updates could disturb it. */
function recentlyActive() {
  const newest = newestSessionMtime()
  return newest > 0 && Date.now() - newest < IDLE_WINDOW_MS
}

/** Where the updater keeps its settings and last report. */
function statePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'plugin-auto-updater', 'state.json')
}

/** Read persisted state, falling back to defaults on a broken file. */
function readState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    return {
      config: normalizeConfig(parsed?.config),
      lastRun: typeof parsed?.lastRun === 'number' ? parsed.lastRun : undefined,
      report: Array.isArray(parsed?.report) ? parsed.report : [],
      checked: typeof parsed?.checked === 'number' ? parsed.checked : undefined,
      failures: parsed?.failures !== null && typeof parsed?.failures === 'object' ? parsed.failures : {},
    }
  } catch {
    return { config: { ...DEFAULT_CONFIG }, lastRun: undefined, report: [], checked: undefined, failures: {} }
  }
}

/** Clamp one stored configuration back into the accepted range. */
function normalizeConfig(value) {
  const config = { ...DEFAULT_CONFIG }
  if (value !== null && typeof value === 'object') {
    if (typeof value.enabled === 'boolean') config.enabled = value.enabled
    if (typeof value.autoApply === 'boolean') config.autoApply = value.autoApply
    if (typeof value.autoRemediate === 'boolean') config.autoRemediate = value.autoRemediate
    if (typeof value.intervalMinutes === 'number' && Number.isFinite(value.intervalMinutes)) {
      config.intervalMinutes = Math.min(1440, Math.max(15, Math.round(value.intervalMinutes)))
    }
  }
  return config
}

/** Persist state. */
function writeState(state) {
  const file = statePath()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/** Parse a semver-ish version into comparable parts. */
function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text ?? '').trim())
  if (match === null) return undefined
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

/** Compare two parsed versions; returns -1, 0, or 1. */
function compareParsed(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] > right.core[index] ? 1 : -1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.pre[index]
    const b = right.pre[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const difference = Number(a) - Number(b)
      if (difference !== 0) return difference > 0 ? 1 : -1
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1
    } else if (a !== b) {
      return a > b ? 1 : -1
    }
  }
  return 0
}

/** Whether `candidate` is a strictly newer version than `current`. */
function isNewer(candidate, current) {
  const next = parseVersion(candidate)
  const installed = parseVersion(current)
  if (next === undefined) return false
  if (installed === undefined) return true
  return compareParsed(next, installed) > 0
}

/** Fetch the npm `latest` dist-tag, trying the default registry and a mirror. */
async function fetchLatest(name) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name
  for (const registry of ['https://registry.npmjs.org', 'https://registry.npmmirror.com']) {
    try {
      const response = await fetch(`${registry}/${encoded}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) continue
      const data = await response.json()
      const latest = data?.['dist-tags']?.latest
      if (typeof latest === 'string' && latest.length > 0) return latest
    } catch {
      // Try the next registry.
    }
  }
  return undefined
}

/** Whether one listed bundle is a third-party registry package this updater may touch. */
function isCandidate(bundle) {
  if (bundle === null || typeof bundle !== 'object') return false
  if (bundle.installed !== true) return false
  if (bundle.name === SELF_NAME) return false
  if (bundle.official === true) return false
  if (bundle.readOnlyReason !== undefined) return false
  if (bundle.error !== undefined) return false
  if (typeof bundle.source !== 'string') return false
  const spec = bundle.source
  if (/^(link|file|git|git\+|github|gitlab|bitbucket|https?):/i.test(spec)) return false
  // Only `name@<semver range or exact>` dependency specs are registry releases.
  if (!spec.startsWith(`${bundle.name}@`)) return false
  const range = spec.slice(bundle.name.length + 1)
  if (!/^(?:[\^~>=<]*v?\d[0-9A-Za-z.\-+]*|\*|latest)$/.test(range)) return false
  return typeof bundle.version === 'string' && parseVersion(bundle.version) !== undefined
}

/** Human-readable reason for a failed management result. */
function describeResult(result) {
  if (result === undefined || result === null) return '没有返回结果'
  const error = result.error
  if (error !== null && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : 'unknown'
    const diagnostic = typeof error.diagnostic === 'string' && error.diagnostic.length > 0 ? ` · ${error.diagnostic}` : ''
    return `${code}${diagnostic}`
  }
  const output = result.packageResult?.output
  if (typeof output === 'string' && output.trim().length > 0) return output.trim().split('\n').slice(-3).join(' / ')
  return `application=${String(result.application ?? 'unknown')}`
}

/** Whether one management result counts as the change being kept. */
function applied(result) {
  const application = result?.application
  return application === 'applied' || application === 'restart-required' || application === 'overridden'
}

/** Update one bundle, with uninstall + reinstall as the refusal fallback. */
async function applyUpdate(ctx, entry, config) {
  const spec = `${entry.name}@${entry.latest}`
  let result
  try {
    result = await ctx.pluginManager.installBundle(spec, {})
  } catch (error) {
    return { ...entry, status: 'failed', reason: `安装异常: ${String(error?.message ?? error)}` }
  }
  if (applied(result)) {
    return { ...entry, status: result.application === 'applied' ? 'updated' : 'restart-required', method: 'install' }
  }
  const code = result?.error?.code
  if (code !== 'already-installed') {
    return { ...entry, status: 'failed', reason: describeResult(result) }
  }
  if (config.autoRemediate !== true) {
    return { ...entry, status: 'failed', reason: 'already-installed（未开启自动卸载重装）' }
  }
  let removed
  try {
    removed = await ctx.pluginManager.removeBundle(entry.name)
  } catch (error) {
    return { ...entry, status: 'failed', reason: `卸载异常: ${String(error?.message ?? error)}` }
  }
  if (!(removed?.application === 'applied' || removed?.application === 'restart-required')) {
    return { ...entry, status: 'failed', reason: `卸载失败: ${describeResult(removed)}` }
  }
  let installed
  try {
    installed = await ctx.pluginManager.installBundle(spec, {})
  } catch (error) {
    installed = undefined
    const message = `重装异常: ${String(error?.message ?? error)}`
    return { ...entry, status: 'failed', reason: `${message}${await restore(ctx, entry)}` }
  }
  if (applied(installed)) {
    return { ...entry, status: installed.application === 'applied' ? 'updated' : 'restart-required', method: 'reinstall' }
  }
  return { ...entry, status: 'failed', reason: `重装失败: ${describeResult(installed)}${await restore(ctx, entry)}` }
}

/** Try to put the previously installed version back after a failed reinstall. */
async function restore(ctx, entry) {
  try {
    const back = await ctx.pluginManager.installBundle(`${entry.name}@${entry.current}`, {})
    return applied(back) ? '（已恢复旧版）' : '（旧版恢复未生效，请到「设置 → 插件」检查）'
  } catch {
    return '（旧版恢复失败，请到「设置 → 插件」检查）'
  }
}

/** One check/apply pass over the installed registry bundles. */
async function runCheck(ctx, apply, only, options = {}) {
  if (runtime.running === true) return { busy: true, ...snapshotState() }
  runtime.running = true
  try {
    const state = readState()
    const config = state.config
    let bundles = []
    try {
      bundles = await ctx.pluginManager.listBundles()
    } catch (error) {
      const report = [{ name: '(profile)', status: 'failed', reason: `无法读取插件列表: ${String(error?.message ?? error)}` }]
      writeState({ ...state, lastRun: Date.now(), report })
      return { busy: false, ...snapshotState() }
    }
    const filter = Array.isArray(only) && only.length > 0 ? new Set(only) : undefined
    const candidates = bundles.filter((bundle) => isCandidate(bundle) && (filter === undefined || filter.has(bundle.name)))
    const failures = { ...state.failures }
    const report = []
    let deferred = false
    for (const bundle of candidates) {
      const latest = await fetchLatest(bundle.name)
      if (latest === undefined) {
        report.push({ name: bundle.name, current: bundle.version, status: 'failed', reason: '无法获取最新版本' })
        continue
      }
      if (!isNewer(latest, bundle.version)) continue
      const entry = { name: bundle.name, current: bundle.version, latest }
      const failure = failures[bundle.name]
      if (failure !== undefined && failure.latest === latest && Date.now() - Number(failure.at ?? 0) < FAILURE_COOLDOWN_MS) {
        report.push({ ...entry, status: 'skipped', reason: '上次失败，12 小时后再试' })
        continue
      }
      if (apply !== true) {
        report.push({ ...entry, status: 'available' })
        continue
      }
      // An automatic pass must not replace plugins while a conversation is active.
      if (options.auto === true && recentlyActive()) {
        report.push({ ...entry, status: 'available', reason: '会话活跃，空闲后自动更新' })
        deferred = true
        continue
      }
      const outcome = await applyUpdate(ctx, entry, config)
      report.push(outcome)
      if (outcome.status === 'failed') failures[bundle.name] = { at: Date.now(), latest, reason: outcome.reason }
      else delete failures[bundle.name]
    }
    writeState({ ...readState(), config, lastRun: Date.now(), report, failures, checked: candidates.length })
    if (deferred) scheduleRetry(ctx)
    return { busy: false, ...snapshotState() }
  } finally {
    runtime.running = false
  }
}

/** Everything the settings page reads. */
function snapshotState() {
  const state = readState()
  return {
    config: state.config,
    lastRun: state.lastRun,
    report: state.report,
    checked: typeof state.checked === 'number' ? state.checked : undefined,
    running: runtime.running,
  }
}

/** The timer and the single in-flight run. */
const runtime = { timer: undefined, first: undefined, retry: undefined, running: false }

/** Retry an automatic pass later when session activity deferred it. */
function scheduleRetry(ctx) {
  if (runtime.retry !== undefined) return
  runtime.retry = setTimeout(() => {
    runtime.retry = undefined
    const config = readState().config
    if (config.enabled !== true || config.autoApply !== true) return
    runCheck(ctx, true, undefined, { auto: true }).catch((error) => console.warn('dsh-auto-update: deferred check failed', error))
  }, DEFERRED_RETRY_MS)
  runtime.retry.unref?.()
}

/** Re-arm the periodic check for the current settings. */
function schedule(ctx) {
  if (runtime.timer !== undefined) clearInterval(runtime.timer)
  runtime.timer = undefined
  if (runtime.first !== undefined) clearTimeout(runtime.first)
  runtime.first = undefined
  if (runtime.retry !== undefined) clearTimeout(runtime.retry)
  runtime.retry = undefined
  const config = readState().config
  if (config.enabled !== true) return
  const interval = Math.max(15, config.intervalMinutes) * 60 * 1000
  runtime.first = setTimeout(() => {
    runCheck(ctx, config.autoApply, undefined, { auto: true }).catch((error) => console.warn('dsh-auto-update: scheduled check failed', error))
  }, FIRST_CHECK_DELAY_MS)
  runtime.first.unref?.()
  runtime.timer = setInterval(() => {
    const current = readState().config
    runCheck(ctx, current.autoApply, undefined, { auto: true }).catch((error) => console.warn('dsh-auto-update: periodic check failed', error))
  }, interval)
  runtime.timer.unref?.()
}

/** Refuse anyone the GUI itself would refuse. */
function admitted(ctx, request, response) {
  const connection = ctx.connection
  if (connection === undefined || typeof connection.requestRejection !== 'function') return true
  const rejection = connection.requestRejection(request)
  if (rejection === undefined) return true
  response.writeHead(typeof rejection === 'number' ? rejection : 403)
  response.end('unauthorized')
  return false
}

/** Send one JSON response. */
function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Read one small JSON request body. */
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let data = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      data += chunk
      if (data.length > 65536) {
        reject(new Error('body-too-large'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try {
        resolve(data.length === 0 ? {} : JSON.parse(data))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    request.on('error', reject)
  })
}

/** Route handlers for the settings page. */
function handlerFor(ctx, kind) {
  return (request, response) => {
    if (!admitted(ctx, request, response)) return
    if (kind === 'state') {
      if (request.method !== 'GET') {
        response.writeHead(405, { allow: 'GET' })
        response.end()
        return
      }
      sendJson(response, 200, snapshotState())
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    readJsonBody(request)
      .then(async (body) => {
        if (kind === 'settings') {
          const current = readState()
          const config = normalizeConfig({ ...current.config, ...body })
          writeState({ ...current, config })
          schedule(ctx)
          sendJson(response, 200, snapshotState())
          return
        }
        // run
        if (runtime.running === true) {
          sendJson(response, 409, { ...snapshotState(), busy: true })
          return
        }
        const result = await runCheck(ctx, body.apply === undefined ? true : body.apply === true, body.only)
        sendJson(response, 200, result)
      })
      .catch((error) => sendJson(response, 400, { error: String(error?.message ?? error) }))
  }
}

/**
 * Register the settings routes and arm the periodic check.
 * @param ctx - Host context with the web server, connection gate, and plugin manager.
 */
export function apply(ctx) {
  for (const [kind, path] of Object.entries(ROUTES)) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path, handler: handlerFor(ctx, kind) }),
      `dsh-auto-update: route ${path}`,
    )
  }
  ctx.effect(() => {
    schedule(ctx)
    return () => {
      if (runtime.timer !== undefined) clearInterval(runtime.timer)
      if (runtime.first !== undefined) clearTimeout(runtime.first)
      if (runtime.retry !== undefined) clearTimeout(runtime.retry)
      runtime.timer = undefined
      runtime.first = undefined
      runtime.retry = undefined
    }
  }, 'dsh-auto-update: schedule')
}

/** The GUI server, the request gate, and the plugin manager are the dependencies. */
export const inject = ['webServer', 'connection', 'pluginManager']
