#!/usr/bin/env node
// Vite/esbuild 解析 `./x` 时 .js 优先于 .ts，src 目录里残留的 tsc 产物会静默遮蔽源码，
// 构建出的扩展跑的是旧代码。此脚本负责清理 + 断言这两件事。
import { execFileSync } from 'node:child_process'
import { readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mode = process.argv[2] === 'check' ? 'check' : 'clean'
const STALE_EXT = ['.js', '.js.map', '.d.ts', '.d.ts.map']

const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: ROOT })
    .toString()
    .split('\0')
    .filter(Boolean)
)

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(abs, out)
    } else if (STALE_EXT.some(ext => entry.name.endsWith(ext))) {
      out.push(abs)
    }
  }
  return out
}

const srcDirs = readdirSync(join(ROOT, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(ROOT, 'packages', entry.name, 'src'))

function findStale() {
  const found = []
  for (const dir of srcDirs) found.push(...walk(dir))
  return found
    .map(abs => relative(ROOT, abs).replace(/\\/g, '/'))
    .filter(relPath => !tracked.has(relPath))
}

const stale = findStale()

if (mode === 'check') {
  if (stale.length) {
    console.error(
      `[guard-src-js] 发现 ${stale.length} 个遮蔽源码的 tsc 产物，构建会跑旧代码：`
    )
    stale.slice(0, 20).forEach(p => console.error('  ' + p))
    if (stale.length > 20) console.error(`  ...还有 ${stale.length - 20} 个`)
    console.error('修复：node scripts/guard-src-js.mjs clean')
    process.exit(1)
  }
  console.log('[guard-src-js] 源码目录干净')
  process.exit(0)
}

for (const relPath of stale) rmSync(join(ROOT, relPath), { force: true })

const survived = findStale()

if (survived.length) {
  console.error(`[guard-src-js] 清理后仍有 ${survived.length} 个残留，删除失败：`)
  survived.slice(0, 10).forEach(p => console.error('  ' + p))
  process.exit(1)
}

console.log(`[guard-src-js] 已清理 ${stale.length} 个 tsc 产物`)
