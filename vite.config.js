import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// Base URL 可通过环境变量 CATCHECK_BASE_URL 配置（用于 GitHub Pages 子路径）
// 默认为根路径 '/'，GitHub Pages 项目页改为 '/ClassCheck/'
const base = process.env.CATCHECK_BASE_URL || '/';
const normalizedBase = base.endsWith('/') ? base : `${base}/`;

export default defineConfig({
  base: normalizedBase,
  plugins: [
    VitePWA({
      // 采用 injectManifest 策略：src/sw.js 处理旧缓存清理和更新消息
      strategies: 'injectManifest',
      injectRegister: null,  // 手动注册，由 src/pwa-register.js 负责
      srcDir: 'src',
      filename: 'sw.js',

      // Manifest 配置
      manifest: {
        name: 'CatCheck',
        short_name: 'CatCheck',
        description: 'Offline-first dormitory attendance assistant',
        lang: 'zh-CN',
        start_url: './',  // 相对路径支持子路径部署
        scope: './',
        display: 'standalone',
        theme_color: '#006a6a',
        background_color: '#f4f7fb',
        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
        ],
      },

      // 需要在 public 中的资源
      includeAssets: [
        'icons/apple-touch-icon.png',
        'icons/icon-192.png',
        'icons/icon-512.png',
        'favicon.ico',
      ],

      // Workbox injectManifest 特定配置
      injectManifest: {
        globPatterns: [
          '**/*.{html,js,css,png,svg,ico,webmanifest}',
        ],
        globIgnores: [
          // OCR 资源分离处理，不进入预缓存（版本化到 ocr/v1/）
          'ocr/**/*',
          '**/*.map',
        ],
        // 允许更大的文件（非 OCR 资源，如 XLSX、图片库等）
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MiB
      },

      // Workbox 缓存策略
      workbox: {
        cleanupOutdatedCaches: true,
        navigateFallback: `${normalizedBase}index.html`,

        // 运行时缓存：版本化 OCR 资源（worker、WASM、语言包）
        runtimeCaching: [
          {
            urlPattern: /\/ocr\/v1\/.*\.(wasm\.js|traineddata\.gz|worker\.min\.js)$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'catcheck-ocr-v1',
              cacheableResponse: {
                statuses: [0, 200],
              },
              expiration: {
                maxEntries: 12,  // worker + WASM core (6 variants) + chi_sim + eng
              },
            },
          },
        ],
      },
    }),
  ],
});
