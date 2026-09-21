import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { crx } from '@crxjs/vite-plugin'
import yaml from '@modyfi/vite-plugin-yaml'
import { resolve } from 'path'
import { copyFileSync, mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import baseManifest from './manifest.json'

const manifest = baseManifest

// 复制静态文件并修改 manifest 的插件
function copyStaticFilesPlugin() {
  return {
    name: 'copy-static-files',
    writeBundle() {

      // 复制 rules 目录
      const rulesDir = resolve(__dirname, 'rules')
      const distRulesDir = resolve(__dirname, 'dist/rules')

      if (existsSync(rulesDir)) {
        if (!existsSync(distRulesDir)) {
          mkdirSync(distRulesDir, { recursive: true })
        }

        const files = readdirSync(rulesDir)
        for (const file of files) {
          copyFileSync(
            resolve(rulesDir, file),
            resolve(distRulesDir, file)
          )
          console.log(`[copy-static] Copied rules/${file}`)
        }
      }

      // 复制 reader 脚本（避免被 vite 转换为 ES modules）
      const readerDir = resolve(__dirname, 'public/lib')
      const distDir = resolve(__dirname, 'dist')

      if (existsSync(readerDir)) {
        const readerFiles = ['reader.js', 'Readability.js']
        for (const file of readerFiles) {
          const srcPath = resolve(readerDir, file)
          const destPath = resolve(distDir, file)
          if (existsSync(srcPath)) {
            copyFileSync(srcPath, destPath)
            console.log(`[copy-static] Copied ${file} to dist/`)
          }
        }
      }

      // 修改输出的 manifest.json，添加 reader 脚本到 content_scripts
      const manifestPath = resolve(__dirname, 'dist/manifest.json')
      if (existsSync(manifestPath)) {
        const manifestContent = JSON.parse(readFileSync(manifestPath, 'utf-8'))

        // 在 content_scripts 开头添加 reader 脚本
        // 不设置 world，使用默认的 ISOLATED world，与 extractor 共享全局变量
        const readerContentScript = {
          js: ['reader.js', 'Readability.js'],
          matches: ['http://*/*', 'https://*/*'],
          run_at: 'document_start'
        }

        // 添加到 content_scripts 数组开头
        manifestContent.content_scripts = [
          readerContentScript,
          ...manifestContent.content_scripts
        ]

        // 追加构建时间到版本号，便于 reload 后在扩展详情页一眼确认本次刷新是否成功。
        // 只用 dist 产物，不污染源码 manifest.json。
        // Chromium 要求 version 每段是 0-65536 的整数且最多 4 段，所以把时间拆成两段：
        // 第 3 段 = 距 2026-01-01 的天数（日级），第 4 段 = HHMM 时分（分钟级，可见 reload 变化）。
        const ts = new Date()
        const pad = (n: number) => String(n).padStart(2, '0')
        const epoch = new Date('2026-01-01T00:00:00')
        const days = Math.floor((ts.getTime() - epoch.getTime()) / 86400000)
        const hhmm = ts.getHours() * 100 + ts.getMinutes()
        const baseSegments = String(manifestContent.version ?? '0.0.0').split('.').slice(0, 2).join('.')
        manifestContent.version = `${baseSegments}.${days}.${hhmm}`

        writeFileSync(manifestPath, JSON.stringify(manifestContent, null, 2))
        console.log('[copy-static] Updated manifest.json with reader scripts')
      }
    }
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const isDev = mode === 'development'
  return {
    plugins: [
      react(),
      yaml(),
      crx({ manifest }),
      copyStaticFilesPlugin(),
    ],
    define: {
      'import.meta.env.VITE_GA_MEASUREMENT_ID': JSON.stringify(env.VITE_GA_MEASUREMENT_ID || ''),
      'import.meta.env.VITE_GA_API_SECRET': JSON.stringify(env.VITE_GA_API_SECRET || ''),
      // 开发模式下覆盖 PROD 标志，让 logger 输出 debug 日志
      'import.meta.env.PROD': JSON.stringify(!isDev),
      'import.meta.env.DEV': JSON.stringify(isDev),
    },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@wechatsync/core': resolve(__dirname, '../core/src'),
    },
  },
  build: {
    // 开发模式: 不压缩，生成 sourcemap
    minify: isDev ? false : 'esbuild',
    sourcemap: isDev ? 'inline' : false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        editor: resolve(__dirname, 'src/editor/index.html'),
        'sync-dialog': resolve(__dirname, 'src/sync-dialog/index.html'),
        preprocessor: resolve(__dirname, 'src/preprocessor/index.html'),
      },
    },
  },
}})
