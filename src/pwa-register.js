/**
 * PWA 注册和更新管理
 * 支持：环境检测、增量更新提示、prompt 模式（用户确认再更新）
 */

/**
 * 检测当前环境是否可以注册 PWA Service Worker
 * - 需要 Service Worker 支持
 * - 不在 Android WebView 中（该环境由原生壳负责缓存）
 * - 不在文件协议下运行
 */
export function canRegisterPwa() {
  const hasServiceWorker = 'serviceWorker' in navigator;
  const isAndroidBridge = !!window.AndroidFileBridge;
  const isFileProtocol = location.protocol === 'file:';

  return hasServiceWorker && !isAndroidBridge && !isFileProtocol;
}

/**
 * 注册 CatCheck PWA Service Worker
 * @param {Object} options - 配置选项
 * @param {Function} options.onOfflineReady - 首次缓存完成回调（可用于显示离线提示）
 * @param {Function} options.onNeedRefresh - 新版本可用回调（显示更新 banner）
 * @param {Object} options.updateGuard - 更新防护状态对象（防止在关键操作期间自动更新）
 * @returns {Promise<RegistrationController>} - 注册控制器，提供 updateServiceWorker() 方法
 */
export async function registerCatCheckPwa(options = {}) {
  if (!canRegisterPwa()) {
    console.info('[PWA] PWA registration skipped: Android bridge or file protocol detected');
    return null;
  }

  try {
    // 动态导入 virtual:pwa-register（由 vite-plugin-pwa 提供）
    const { registerSW } = await import('virtual:pwa-register');

    // 配置更新策略：prompt 模式
    const updateSW = registerSW({
      immediate: false,  // 不自动更新，等待明确操作
      onOfflineReady() {
        console.info('[PWA] Offline capability ready');
        options.onOfflineReady?.();
      },
      onNeedRefresh() {
        // 检查防护状态：在关键操作（导入、OCR、恢复备份、保存）期间不显示更新提示
        const guardState = options.updateGuard || {};
        const isGuarded =
          guardState.isImporting ||
          guardState.isRecognizingOcr ||
          guardState.isRestoringBackup ||
          guardState.isSaving ||
          guardState.hasUnsavedAttendanceDraft;

        if (isGuarded) {
          console.info('[PWA] Update available but guarded by critical operation');
          return;
        }

        console.info('[PWA] New version available');
        options.onNeedRefresh?.();
      },
      onRegistered(registration) {
        console.info('[PWA] Service Worker registered', registration);
      },
      onRegisterError(error) {
        console.error('[PWA] Service Worker registration failed:', error);
      },
    });

    // 返回更新控制器
    return {
      updateServiceWorker: () => {
        console.info('[PWA] User accepted update, switching to new version');
        updateSW(true);
      },
    };
  } catch (error) {
    console.error('[PWA] Failed to register PWA:', error);
    return null;
  }
}
