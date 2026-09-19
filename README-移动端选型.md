# CatCheck（喵喵查寝）移动端选型

[English README](README.md) | [中文项目首页](README.zh-CN.md)

## 结论

移动端采用 **Kotlin 原生 Android 壳 + 内置离线 Web 核心**。

安装 APK 后直接打开，不需要启动电脑服务，不需要账号，不需要网络。现有 Web 版已经完成的名单导入、图片 OCR、按宿舍点名、历史记录、汇报生成和多格式导出，会随 APK 一起打包到手机。名单字段固定为宿舍号、姓名、班级，不使用学号。

这比重新用 Kotlin 重写全部页面更适合当前项目：工具规模小，但 OCR、Excel 读写和图片导出属于成熟 Web 能力，直接复用可以减少重复实现和功能偏差。Kotlin 原生层只负责 Android 特有能力，例如系统文件选择器和保存到手机下载目录。

## 方案比较

| 方案 | 是否直接安装 | 离线能力 | 开发成本 | 文件/OCR能力 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 浏览器 PWA | 部分支持 | 首次访问后可离线 | 低 | 依赖浏览器能力 | 保留为网页版和快速预览 |
| Kotlin 原生重写 | 是 | 强 | 高 | 需要重新接入 Excel、OCR、图片导出 | 后续长期演进方案 |
| Flutter | 是 | 强 | 中 | 需要 Dart 插件和原生配置 | 当前项目没有必要引入新技术栈 |
| **Kotlin + WebView 离线壳** | **是** | **强** | **中低** | **复用现有 OCR、Excel 和导出逻辑** | **当前版本采用** |

## 技术选型

### Android 原生层

- Kotlin 2.x
- Android Gradle Plugin 8.5.x
- `WebView` 加载 APK 内部资源
- `WebChromeClient.onShowFileChooser` 调用系统文件选择器
- `JavascriptInterface` 提供原生文件保存桥接
- `MediaStore.Downloads` 将导出文件写入“下载/喵喵查寝”
- 基线版本不声明网络权限，保证查寝核心流程不依赖网络

### 内置 Web 核心

- Vite 生产构建
- 原有移动端页面和 CSS
- IndexedDB 保存学生、查寝记录和设置
- Tesseract.js + 中文/英文语言包进行本地 OCR
- SheetJS 读写 Excel、CSV 和汇报表格
- PNG/JPG 由 Canvas 本地生成

## APK 内部结构

```text
Android APK
├── Kotlin MainActivity
│   ├── 加载本地 Web 资源
│   ├── 调用 Android 文件选择器
│   └── 将导出文件保存到手机 Download/喵喵查寝
└── assets
    ├── index.html、CSS、JavaScript
    ├── OCR worker、中文/英文语言包
    └── PWA 资源和图标
```

## 数据与安全

- 学生名单和查寝历史保存在 WebView 的本地 IndexedDB。
- APK 不申请网络权限，名单不会上传。
- 导入仍然先预览、后确认；保留去重、字段校验和公式注入拦截。
- 导出文件名由应用生成，原生保存层会再次清理非法文件名字符。
- 更换手机前使用 JSON 备份；Android 应用数据清除后，未备份数据不能恢复。

## 当前工程状态

- `android/` 是可导入 Android Studio 的 Kotlin 工程。
- `android/sync-web-assets.ps1` 将最新 Web 生产构建复制进 APK 资源目录。
- APK、签名材料、本地数据库和构建目录均由 Git 忽略，不会进入源码仓库。
- 工程已在 Android Studio 环境完成 debug APK 构建，可直接用 Android Studio 打开 `android/` 后继续调试或发布。
- 第一个 Android 版本目标为 Android 10（API 29）及以上，使用 `MediaStore` 保存文件，不需要存储权限弹窗。

## 构建流程

```powershell
# 项目根目录
npm install
./android/sync-web-assets.ps1

# 用 Android Studio 打开 android 目录
# 等待 Gradle 同步完成后，Build > Build APK(s)
```

生成的调试 APK 通常位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```
