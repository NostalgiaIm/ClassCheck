import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { clientsClaim } from 'workbox-core';

// Service Worker 立即声明对所有客户端的控制权
clientsClaim();

// Workbox injectManifest 会在构建时注入预缓存清单到这里
precacheAndRoute(self.__WB_MANIFEST);

// 清理构建时过期的预缓存
cleanupOutdatedCaches();

// 在 activate 事件中明确清理旧缓存（从 v8 及以前的手写 Worker 版本过渡）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.delete('catcheck-shell-v8').catch(() => {
      // 缓存不存在时不报错
    })
  );
});

// 处理来自客户端的 SKIP_WAITING 消息，立即更新
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// 后续可扩展 fetch 拦截以支持请求去重、持久化日志等
