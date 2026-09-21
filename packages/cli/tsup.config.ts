import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  dts: true,
  clean: true,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  // 把 mcp-server 与 juice 都打进单文件，不做外部依赖
  // （juice 也 bundle 进来，使 CLI 自包含，不依赖运行目录额外安装）
  noExternal: ['@wechatsync/mcp-server', 'juice'],
})
