/**
 * The suite runner.
 *
 * `node --test` spawns a child process per file with piped stdio, which the
 * DSH sandbox denies on some hosts; this runner imports each test module in
 * turn so the same cases run everywhere. Every module follows the same tiny
 * convention: it registers cases and prints `ok`/`FAIL` lines, and exits
 * non-zero on a failure.
 */
import { spawn } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = dirname(fileURLToPath(import.meta.url))

/**
 * Run one test module in this process's child.
 * @param {string} file - absolute path.
 * @returns {Promise<{ file: string, code: number, output: string }>} the outcome.
 */
function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      resolve({ file, code, output })
    }
    // A module that leaves an interval behind would otherwise hang the whole
    // suite; a per-file budget turns that into a visible failure.
    const timer = setTimeout(() => finish(124), 60_000)
    timer.unref?.()
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', (error) => {
      output += String(error)
      finish(1)
    })
    child.on('close', (code) => finish(code ?? 1))
  })
}

const files = (await readdir(directory))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => join(directory, name))

let failed = 0
for (const file of files) {
  const result = await runOne(file)
  if (result.code !== 0) {
    failed += 1
    console.log(`\n=== ${file} ===`)
    console.log(result.output.trim())
  } else {
    const summary = result.output.trim().split('\n').filter((line) => /pass(ed)?$/u.test(line)).pop() ?? 'ok'
    console.log(`${file.split(/[\\/]/u).pop()}: ${summary}`)
  }
}
console.log(failed === 0 ? `\nall ${files.length} test files passed` : `\n${failed}/${files.length} test files FAILED`)
if (failed > 0) process.exitCode = 1
