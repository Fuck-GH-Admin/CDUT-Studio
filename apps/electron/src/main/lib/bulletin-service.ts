/**
 * 本地系统公告栏（Bulletin）服务
 *
 * 读取应用内置的 bulletin.json，返回系统公告列表。
 * 数据由版本迭代时随安装包本地维护，零外部网络请求。
 */

import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BulletinFile, BulletinItem } from '@profer/shared'

/**
 * 内置资源目录
 * dev: __dirname/resources（build:resources 阶段拷贝）
 * prod: process.resourcesPath（electron-builder extraResources 产物）
 */
function getBundledResourcesDir(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, 'resources')
}

/**
 * 读取内置公告数据
 *
 * @returns 公告列表；文件缺失或解析失败时返回空数组，绝不抛错
 */
export function getBulletins(): BulletinItem[] {
  try {
    const filePath = join(getBundledResourcesDir(), 'bulletin.json')
    if (!existsSync(filePath)) {
      console.warn('[Bulletin] 未找到内置 bulletin.json:', filePath)
      return []
    }

    const raw = readFileSync(filePath, 'utf-8')
    const data = JSON.parse(raw) as BulletinFile
    return Array.isArray(data.items) ? data.items : []
  } catch (error) {
    console.error('[Bulletin] 读取内置公告失败:', error)
    return []
  }
}
