/**
 * ONNX Runtime 紧凑模型加载器（CPU / DirectML 优雅保底）
 *
 * 目标：当随包就绪的轻量版面模型（RT-DocLayout 蒸馏版等）存在时，用 ONNX Runtime
 * 加速版面切分；模型或运行时缺失时 **100% 平滑保底**——引擎自动回落纯 TS 几何分段，
 * 不抛错、不阻塞、不伪造预测结果。
 *
 * 依赖加载采用非字面量说明符动态 import，未安装 onnxruntime-node 时不影响类型检查。
 */

/** 版面模型推理端口 */
export interface LayoutModelPort {
  readonly available: boolean
  readonly unavailableReason?: string
  /**
   * 对页面位图做版面预测。
   * 就绪时返回模型的原始输出张量集合（解码由模型专属后处理负责）；
   * 不可用时返回 null，调用方回落几何分段。
   */
  predictLayout(
    image: Uint8Array,
    size: { width: number; height: number },
  ): Promise<Record<string, unknown> | null>
}

export interface OnnxAdapterOptions {
  /** 模型文件绝对路径；缺省视为未就绪 */
  modelPath?: string
  /** 执行提供者优先级，如 ['cpu'] 或 ['dml', 'cpu']（DirectML） */
  executionProviders?: string[]
}

interface OrtTensor {
  data: unknown
  dims: number[]
}

interface OrtSession {
  run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>
}

interface OrtModule {
  InferenceSession: {
    create(path: string, options?: Record<string, unknown>): Promise<OrtSession>
  }
}

/** 空实现：如实声明不可用（引擎回落几何分段） */
class UnavailableLayoutModel implements LayoutModelPort {
  readonly available = false
  readonly unavailableReason: string

  constructor(reason: string) {
    this.unavailableReason = reason
  }

  async predictLayout(): Promise<Record<string, unknown> | null> {
    return null
  }
}

/** 就绪实现：已加载 ONNX 会话 */
class OnnxLayoutModel implements LayoutModelPort {
  readonly available = true
  private readonly session: OrtSession

  constructor(session: OrtSession) {
    this.session = session
  }

  async predictLayout(
    image: Uint8Array,
    size: { width: number; height: number },
  ): Promise<Record<string, unknown> | null> {
    // 输入张量名与形状依赖具体模型，这里以通用约定 'input' 传入；
    // 形状不符时由模型/运行时抛错，调用方捕获后回落几何分段。
    const feeds: Record<string, unknown> = {}
    const tensor = (this as unknown as { ort?: { Tensor: new (type: string, data: Uint8Array, dims: number[]) => unknown } }).ort
    if (tensor) {
      feeds.input = new tensor.Tensor('uint8', image, [1, 3, size.height, size.width])
    } else {
      feeds.input = image
    }
    return this.session.run(feeds) as unknown as Promise<Record<string, unknown> | null>
  }
}

/**
 * 创建 ONNX 版面模型适配器。
 *
 * 依次探测：运行时依赖 → 模型文件 → 会话创建；任一步骤失败都返回不可用实例。
 */
export async function createOnnxLayoutAdapter(options: OnnxAdapterOptions = {}): Promise<LayoutModelPort> {
  if (!options.modelPath) {
    return new UnavailableLayoutModel('未配置 ONNX 版面模型路径（引擎使用纯 TS 几何分段）')
  }

  let ort: OrtModule
  try {
    const specifier = 'onnxruntime-node'
    ort = (await import(specifier)) as unknown as OrtModule
  } catch {
    return new UnavailableLayoutModel('onnxruntime-node 未安装（引擎使用纯 TS 几何分段）')
  }

  try {
    const session = await ort.InferenceSession.create(options.modelPath, {
      executionProviders: options.executionProviders ?? ['cpu'],
    })
    const model = new OnnxLayoutModel(session)
    ;(model as unknown as { ort?: unknown }).ort = ort
    return model
  } catch (error) {
    return new UnavailableLayoutModel(
      `ONNX 版面模型加载失败: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
