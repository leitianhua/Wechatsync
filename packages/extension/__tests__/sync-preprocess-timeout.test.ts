import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chromeMock } from '../vitest.setup'

const { syncToMultiplePlatforms } = vi.hoisted(() => ({
  syncToMultiplePlatforms: vi.fn(),
}))

vi.mock('../src/adapters', () => ({
  syncToMultiplePlatforms,
  getAllPlatformMetas: () => [{ id: 'juejin', name: '掘金' }],
  getPlatformPreprocessConfigs: () => ({ juejin: {} }),
}))

import { performSync } from '../src/background/sync-service'

describe('performSync preprocess timeouts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    ;(chromeMock as any).action = {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    }
    chromeMock.tabs.query.mockImplementation(async (query: { active?: boolean }) => {
      if (query?.active) return [{ id: 1, url: 'https://example.com/source' }]
      return [{ id: 1, url: 'https://example.com/source' }]
    })
    // 模拟卡死的渲染进程：sendMessage 永远不返回
    chromeMock.tabs.sendMessage.mockImplementation(() => new Promise(() => {}))
    syncToMultiplePlatforms.mockImplementation(async (_ids: string[], _article: unknown, callbacks: any) => {
      callbacks.onResult({ platform: 'juejin', success: true, postUrl: 'https://juejin.cn/post/1' })
      return [{ platform: 'juejin', success: true }]
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts publishing instead of hanging when a tab never answers preprocessing', async () => {
    const promise = performSync(
      { title: '标题', html: '<p>正文</p>', markdown: '正文' },
      ['juejin'],
      { source: 'mcp', draftOnly: true }
    )

    // 单 tab 预处理上限 3s；到点必须放弃预处理、带着原始内容继续发布
    await vi.advanceTimersByTimeAsync(4000)
    const result = await promise

    expect(syncToMultiplePlatforms).toHaveBeenCalledTimes(1)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].success).toBe(true)
  })
})
