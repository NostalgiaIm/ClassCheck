# CatCheck（喵喵查寝）移动端选型

[English README](README.md) | [中文项目首页](README.zh-CN.md)

## 结论

移动端主交付采用 **Kotlin 原生 Android 壳 + 内置离线 Web 核心**，同时提供 **iOS SwiftPM/WKWebView 包**用于在 Xcode 中签名运行。

安装 APK 后直接打开，不需要启动电脑服务，不需要账号，不需要网络。iOS 包打开 `ios/CatCheck/Package.swift` 后由 WKWebView 加载同一套内置 Web 资源，需要通过 Xcode 和 Apple Developer 签名后安装到真机或分发。现有 Web 版已经完成的名单导入、图片 OCR、按宿舍点名、历史记录、汇报生成和多格式导出，会随 Android APK 与 iOS 包一起打包。名单字段固定为宿舍号、姓名、班级，不使用学号。

这比重新用 Kotlin 重写全部页面更适合当前项目：工具规模小，但 OCR、Excel 读写和图片导出属于成熟 Web 能力，直接复用可以减少重复实现和功能偏差。Kotlin 原生层只负责 Android 特有能力，例如系统文件选择器和保存到手机下载目录。

## 方案比较

| 方案 | 是否直接安装 | 离线能力 | 开发成本 | 文件/OCR能力 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 浏览器 PWA | 部分支持 | 首次访问后可离线 | 低 | 依赖浏览器能力 | 保留为网页版和快速预览 |
| Kotlin 原生重写 | 是 | 强 | 高 | 需要重新接入 Excel、OCR、图片导出 | 后续长期演进方案 |
| Flutter | 是 | 强 | 中 | 需要 Dart 插件和原生配置 | 当前项目没有必要引入新技术栈 |
| iOS SwiftPM + WKWebView | 需要 Xcode 签名 | 强 | 中低 | 复用现有 OCR、Excel 和导出逻辑 | 作为 iOS 交付包提供 |
| **Kotlin + WebView 离线壳** | **是** | **强** | **中低** | **复用现有 OCR、Excel 和导出逻辑** | **当前 Android 主交付采用** |

## 技术选型

### Android 原生层

- Kotlin 2.x
- Android Gradle Plugin 8.5.x
- `WebView` 加载 APK 内部资源
- `WebChromeClient.onShowFileChooser` 调用系统文件选择器
- `JavascriptInterface` 提供原生文件保存桥接
- `MediaStore.Downloads` 将导出文件写入“下载/喵喵查寝”
- 基线版本不声明网络权限，保证查寝核心流程不依赖网络

### iOS 包

- SwiftPM 包入口为 `ios/CatCheck/Package.swift`
- Swift 5.9，平台目标为 iOS 16+
- SwiftUI 应用入口位于 `ios/CatCheck/WebSources/CatCheckApp.swift`
- `WKWebView` 加载 `WebSources/Resources/www/index.html`
- Release 附件 `CatCheck-iOS-M3-TopNav-v1.2.3.zip` 已包含同步后的 Web 资源
- 真机、TestFlight 或 App Store 分发由 Xcode 与 Apple Developer 签名配置完成

### 内置 Web 核心

- Vite 生产构建
- 原有移动端页面和 CSS
- IndexedDB 保存学生、查寝记录和设置
- Tesseract.js + 中文/英文语言包进行本地 OCR
- SheetJS 读写 Excel、CSV 和汇报表格
- PNG/JPG 由 Canvas 本地生成

## 移动包结构

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

iOS SwiftPM 包
├── Package.swift
└── WebSources
    ├── CatCheckApp.swift
    └── Resources/www
        ├── index.html、CSS、JavaScript
        ├── OCR worker、中文/英文语言包
        └── PWA 资源和图标
```

## 数据与安全

- 学生名单和查寝历史保存在 WebView 的本地 IndexedDB。
- APK 不申请网络权限，名单不会上传。
- iOS 包通过 WKWebView 加载内置资源，数据保存在设备本地；真机发布前需要复测 iOS 文件导入、导出和备份恢复。
- 导入仍然先预览、后确认；保留去重、字段校验和公式注入拦截。
- 导出文件名由应用生成，原生保存层会再次清理非法文件名字符。
- 更换手机前使用 JSON 备份；Android 应用数据清除后，未备份数据不能恢复。

## 当前工程状态

- `android/` 是可导入 Android Studio 的 Kotlin 工程。
- `ios/CatCheck/` 是可由 Xcode 打开的 SwiftPM/WKWebView iOS 包。
- `android/sync-web-assets.ps1` 将最新 Web 生产构建复制进 APK 资源目录。
- APK、IPA、签名材料、本地数据库和构建目录均由 Git 忽略，不会进入源码仓库。
- 工程已在 Android Studio 环境完成 debug APK 构建，可直接用 Android Studio 打开 `android/` 后继续调试或发布。
- 第一个 Android 版本目标为 Android 10（API 29）及以上，使用 `MediaStore` 保存文件，不需要存储权限弹窗。

## 构建流程

### Android

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

### iOS

Release 附件 `CatCheck-iOS-M3-TopNav-v1.2.3.zip` 已包含同步后的 Web 资源。源码方式可直接打开：

```text
ios/CatCheck/Package.swift
```

在 Xcode 中选择 iOS 16+ 模拟器或真机运行。真机安装、TestFlight 或 App Store 分发需要配置自己的 Apple Developer 团队、Bundle Identifier 和签名描述文件。
