import { describe, it, expect } from 'vitest'
import { CodeAdapter, type ImageProcessOptions, type ImageUploadResult } from '../code-adapter'
import type { Article, AuthResult, SyncResult } from '../../types'
import type { PublishOptions } from '../types'

class TestAdapter extends CodeAdapter {
  readonly meta = {
    id: 'test',
    name: 'Test',
    icon: '',
    homepage: '',
    capabilities: [],
  }

  async checkAuth(): Promise<AuthResult> {
    return { isAuthenticated: true }
  }

  async publish(_article: Article, _options?: PublishOptions): Promise<SyncResult> {
    return { platform: this.meta.id, success: true }
  }

  run(content: string, uploadFn: (src: string) => Promise<ImageUploadResult>, options?: ImageProcessOptions) {
    return this.processImages(content, uploadFn, options)
  }
}

describe('processImages perImageTimeout', () => {
  it('skips a hung image and keeps processing the rest', async () => {
    const adapter = new TestAdapter()
    const content = '![a](https://example.com/a.png)\n![b](https://example.com/b.png)'

    const startedAt = Date.now()
    const result = await adapter.run(
      content,
      (src) => {
        if (src.endsWith('a.png')) return new Promise(() => {}) // 永不返回
        return Promise.resolve({ url: 'https://cdn.example.com/b.png' })
      },
      { perImageTimeout: 50 }
    )

    expect(Date.now() - startedAt).toBeLessThan(2000)
    expect(result).toContain('https://example.com/a.png')
    expect(result).toContain('https://cdn.example.com/b.png')
  })

  it('keeps the legacy wait-forever behavior when no timeout is set', async () => {
    const adapter = new TestAdapter()
    const result = await adapter.run('![a](https://example.com/a.png)', () =>
      Promise.resolve({ url: 'https://cdn.example.com/a.png' })
    )
    expect(result).toContain('https://cdn.example.com/a.png')
  })
})

describe('processImages concurrency', () => {
  it('runs uploads in parallel up to the limit and preserves document order', async () => {
    const adapter = new TestAdapter()
    const content = [1, 2, 3, 4].map(i => `![i${i}](https://example.com/${i}.png)`).join('\n')

    let inFlight = 0
    let peak = 0
    const startedAt = Date.now()
    const result = await adapter.run(
      content,
      async (src) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise(resolve => setTimeout(resolve, 100))
        inFlight--
        return { url: `https://cdn.example.com/${src.split('/').pop()}` }
      },
      { concurrency: 3 }
    )

    expect(peak).toBe(3)
    // 串行至少要 4×100ms，这里应在一个批次多一点内完成
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(result.indexOf('cdn.example.com/1.png')).toBeLessThan(result.indexOf('cdn.example.com/2.png'))
    expect(result.indexOf('cdn.example.com/2.png')).toBeLessThan(result.indexOf('cdn.example.com/3.png'))
    expect(result.indexOf('cdn.example.com/3.png')).toBeLessThan(result.indexOf('cdn.example.com/4.png'))
  })

  it('uploads a duplicated src only once and replaces every occurrence', async () => {
    const adapter = new TestAdapter()
    const content = '![a](https://example.com/same.png)\n![b](https://example.com/same.png)'
    let calls = 0

    const result = await adapter.run(
      content,
      async () => {
        calls++
        return { url: 'https://cdn.example.com/same.png' }
      },
      { concurrency: 3 }
    )

    expect(calls).toBe(1)
    expect(result.match(/https:\/\/cdn\.example\.com\/same\.png/g)).toHaveLength(2)
  })
})
