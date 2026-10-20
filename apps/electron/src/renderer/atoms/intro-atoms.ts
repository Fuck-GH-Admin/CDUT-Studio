/**
 * intro-atoms — 开屏动画（Intro Overlay）重播状态
 *
 * 用于从主界面手动触发「开屏水波纹动画」：
 *  - replayIntroOpenAtom 置为 true 时，App 顶层渲染全屏 IntroOverlay
 *  - 动画结束（或用户点按跳过）后回调将 atom 重置为 false
 *
 * 该入口不影响 onboardingCompleted 等持久化状态，纯粹用于重播/测试动画。
 */
import { atom } from 'jotai'

/** 是否展示全屏开屏动画重播遮罩 */
export const replayIntroOpenAtom = atom(false)

/**
 * 开屏重播结束后是否进入首次欢迎导览（欢迎 / 功能导览 / 导入数据 / 诗意插页 / 欢迎您）。
 * 走 OnboardingView 的 persistCompletion=false 分支，不写 onboardingCompleted，可反复重放。
 */
export const replayWelcomeTourAtom = atom(false)
