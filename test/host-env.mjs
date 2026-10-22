/**
 * Locate the shipped DSH packages and this plugin for the real-host harnesses.
 *
 * The real-host tests load the *actual* DSH packages out of the installed
 * application (`app.asar`), so the location is a machine fact, not a repository
 * fact. It is resolved in this order:
 *
 *   1. `$DSH_APP_ROOT` — the directory holding `resources/app.asar`, when a CI
 *      or user points at one explicitly;
 *   2. a small search of the usual install locations for the running platform;
 *   3. otherwise the harnesses skip with a clear reason instead of failing with
 *      a stack trace about a missing file.
 *
 * The plugin itself is always resolved relative to this file, so a checkout is
 * tested whatever directory it lives in.
 *
 * @module test/host-env
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** This checkout's root, independent of where it was cloned. */
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Candidate install roots that hold `resources/app.asar`. */
const CANDIDATE_ROOTS = [
  process.env.DSH_APP_ROOT,
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'DeepSeek Harness'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'DeepSeek Harness'),
  '/Applications/DeepSeek Harness.app/Contents',
  join(process.env.HOME ?? '', '.local', 'share', 'deepseek-harness'),
].filter((value) => typeof value === 'string' && value.length > 0)

/**
 * Find the package directory inside the installed application.
 *
 * Under `ELECTRON_RUN_AS_NODE=1` the running binary *is* the application, so
 * `process.execPath` names the install exactly — that is tried before any
 * guesswork. The candidate list then covers a checkout run with plain Node.
 *
 * @returns {string | undefined} the `@deepseek-ai` packages root, when present.
 */
export function findPackagesRoot() {
  const explicit = process.env.DSH_PACKAGES_ROOT
  if (typeof explicit === 'string' && existsSync(explicit)) return explicit

  /** Try one application root. */
  const probe = (root) => {
    if (typeof root !== 'string' || root.length === 0) return undefined
    const asar = join(root, 'resources', 'app.asar')
    if (!existsSync(asar)) return undefined
    // Electron exposes the archive as a directory to its own Node runtime.
    const packages = join(asar, 'dsh', 'node_modules', '@deepseek-ai')
    return existsSync(packages) ? packages : undefined
  }

  const running = probe(dirname(process.execPath))
  if (running !== undefined) return running
  for (const root of CANDIDATE_ROOTS) {
    const found = probe(root)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Import one shipped DSH package, or explain why the harness must skip.
 * @returns {Promise<{ load: (path: string) => Promise<any>, packagesRoot: string, pluginEntry: string } | undefined>} the loader.
 */
export async function hostEnvironment() {
  const packagesRoot = findPackagesRoot()
  if (packagesRoot === undefined) return undefined
  const base = pathToFileURL(packagesRoot).href
  return {
    packagesRoot,
    pluginEntry: pathToFileURL(join(pluginRoot, 'lib', 'host.js')).href,
    load: (path) => import(`${base}/${path}`),
  }
}

/**
 * Print the skip reason and end the harness.
 *
 * A harness cannot continue without the packages it loads, so this exits the
 * process rather than returning: a silent continuation would fail later with a
 * stack trace about an undefined loader, which reads as a plugin defect.
 *
 * @param {string} reason - what is missing.
 */
export function skip(reason) {
  console.log(`SKIP ${reason}`)
  console.log('\n0 checks ran (real-host harness skipped)')
  process.exit(0)
}
