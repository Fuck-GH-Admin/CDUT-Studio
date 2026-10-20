/**
 * CSLab OOXML 独立 Worker 线程入口
 *
 * 由 esbuild 单独打包为 dist/cslab-ooxml-worker.cjs；
 * 主进程通过 worker_threads 调用，避免大 docx 解压占用主线程。
 */

import { parentPort } from 'node:worker_threads'
import { executeOoxmlTask, type CsLabOoxmlTask } from './cslab-ooxml'

interface WorkerRequest {
  type: CsLabOoxmlTask['type']
  buffer?: Uint8Array
  capsules?: unknown
  input?: unknown
}

if (!parentPort) {
  throw new Error('cslab-ooxml-worker 必须在 worker_threads 中运行')
}

parentPort.on('message', async (raw: WorkerRequest) => {
  try {
    const result = await executeOoxmlTask(raw as unknown as CsLabOoxmlTask)
    parentPort?.postMessage({ ok: true, result })
  } catch (error) {
    parentPort?.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
})
