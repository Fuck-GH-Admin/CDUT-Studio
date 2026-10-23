/**
 * 长期记忆图谱 IPC 注册
 *
 * 只暴露「读图谱 / 增 / 改 / 删 / 检索测试」五个最小面。
 * 写成功后向所有存活窗口广播 CHANGED，保证主窗与 CSLab 次窗状态一致。
 */

import { BrowserWindow, ipcMain } from 'electron'
import {
  LONGTERM_MEMORY_IPC_CHANNELS,
  type LongTermMemoryGraph,
  type LongTermMemoryHit,
  type LongTermMemoryNode,
  type LongTermMemoryNodeInput,
} from '@profer/shared'
import { searchLongTermMemory } from './longterm-memory-rag'
import {
  addLongTermMemoryNode,
  deleteLongTermMemoryNode,
  readLongTermMemoryGraph,
  updateLongTermMemoryNode,
} from './longterm-memory-store'

/**
 * 广播图谱变更。
 * 窗口可能正在关闭，必须双重判活；否则 webContents.send 会抛
 * "Object has been destroyed" 直接打崩主进程。
 */
function broadcastChanged(): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(LONGTERM_MEMORY_IPC_CHANNELS.CHANGED)
      }
    }
  } catch (error) {
    console.warn('[长期记忆] 变更广播失败（已隔离）:', error)
  }
}

export function registerLongTermMemoryIpc(): void {
  ipcMain.handle(LONGTERM_MEMORY_IPC_CHANNELS.READ_GRAPH, (): LongTermMemoryGraph => {
    return readLongTermMemoryGraph()
  })

  ipcMain.handle(
    LONGTERM_MEMORY_IPC_CHANNELS.ADD_NODE,
    async (_event, input: LongTermMemoryNodeInput): Promise<LongTermMemoryNode> => {
      const node = await addLongTermMemoryNode(input)
      broadcastChanged()
      return node
    },
  )

  ipcMain.handle(
    LONGTERM_MEMORY_IPC_CHANNELS.UPDATE_NODE,
    async (_event, node: LongTermMemoryNode): Promise<LongTermMemoryNode | null> => {
      const updated = await updateLongTermMemoryNode(node.id, {
        category: node.category,
        title: node.title,
        content: node.content,
        tags: node.tags,
        confidence: node.confidence,
      })
      if (updated) broadcastChanged()
      return updated
    },
  )

  ipcMain.handle(
    LONGTERM_MEMORY_IPC_CHANNELS.DELETE_NODE,
    async (_event, nodeId: string): Promise<{ success: boolean }> => {
      const success = await deleteLongTermMemoryNode(nodeId)
      if (success) broadcastChanged()
      return { success }
    },
  )

  ipcMain.handle(
    LONGTERM_MEMORY_IPC_CHANNELS.QUERY_TEST,
    (_event, input: { query: string; topK?: number }): LongTermMemoryHit[] => {
      return searchLongTermMemory(input?.query ?? '', { topK: input?.topK })
    },
  )
}
