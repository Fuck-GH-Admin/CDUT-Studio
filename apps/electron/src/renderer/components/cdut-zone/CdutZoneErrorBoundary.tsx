/**
 * CdutZoneErrorBoundary — CDUT 专区局部异常熔断保护器
 *
 * 职责：
 *   - 拦截专区内业务域抽屉、Bento 卡片或子页面渲染发生的未捕获异常；
 *   - 杜绝单个前端组件崩溃导致整个 Electron 窗口白屏；
 *   - 呈现优雅的友好错误卡片与一键重试复位按钮。
 */

import * as React from 'react'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@profer/ui/primitives/button'

interface Props {
  children: React.ReactNode
  fallbackTitle?: string
}

interface State {
  hasError: boolean
  error: Error | null
}

export class CdutZoneErrorBoundary extends React.Component<Props, State> {
  public override state: State = {
    hasError: false,
    error: null,
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  public override componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error('[CdutZoneErrorBoundary] 捕获组件渲染异常:', error, errorInfo)
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  public override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-full min-h-[220px] w-full flex-col items-center justify-center p-6 text-center">
          <div className="flex size-12 items-center justify-center rounded-2xl border border-destructive/20 bg-destructive/10 text-destructive shadow-xs">
            <AlertCircle size={24} />
          </div>
          <h4 className="mt-3 text-sm font-semibold text-foreground">
            {this.props.fallbackTitle ?? 'CDUT 专区组件加载异常'}
          </h4>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
            {this.state.error?.message || '组件在渲染过程中发生未预期的错误，已自动熔断保护。'}
          </p>
          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={this.handleReset}
              className="inline-flex items-center gap-1.5"
            >
              <RefreshCw size={13} />
              <span>重新加载组件</span>
            </Button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
