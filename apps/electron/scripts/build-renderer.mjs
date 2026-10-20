#!/usr/bin/env node
/**
 * Renderer 构建包装器
 *
 * Mol* 会把模块图扩大到 ~1.2 万个模块，Vite/Rollup 默认 4GB 堆在转换阶段会 OOM。
 * 这里统一提高 Node 堆上限后再启动 vite build，避免 CI / 本地构建随机失败。
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const vitePkgPath = require.resolve('vite/package.json')
const vitePkg = JSON.parse(readFileSync(vitePkgPath, 'utf-8'))
const binField = vitePkg.bin
const binRelative = typeof binField === 'string' ? binField : Object.values(binField ?? {})[0]
if (!binRelative) {
  console.error('[build-renderer] 无法定位 vite CLI 入口')
  process.exit(1)
}
const viteBin = resolve(dirname(vitePkgPath), binRelative)

const nodeOptions = [process.env.NODE_OPTIONS, '--max-old-space-size=8192']
  .filter(Boolean)
  .join(' ')

const result = spawnSync(process.execPath, [viteBin, 'build'], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: nodeOptions },
})

process.exit(result.status ?? 1)
