# CatCheck iOS Package

This directory contains the iOS SwiftPM/WKWebView package for CatCheck / 喵喵查寝. It embeds the same web bundle used by the Android v1.2.3 top-navigation build, so the pale-teal Material 3 UI, GitHub "Join us" dialog, and Today / History / Roster navigation stay consistent across mobile targets.

## Requirements

- Xcode 15 or newer
- iOS 16+ simulator or device
- Apple Developer signing configuration for real-device installation, TestFlight, or App Store delivery

## Structure

```text
ios/CatCheck
├── Package.swift
└── WebSources
    ├── CatCheckApp.swift
    └── Resources/www
        └── Bundled CatCheck web build
```

`CatCheckApp.swift` creates a SwiftUI app and loads `Resources/www/index.html` through WKWebView. The package does not require a development server at runtime.

## Run in Xcode

1. Open `ios/CatCheck/Package.swift` in Xcode.
2. Select an iOS 16+ simulator or device.
3. For a physical device, set your Team, Bundle Identifier, and signing profile in Xcode.
4. Run the `CatCheck` target.

The GitHub Release asset `CatCheck-iOS-M3-TopNav-v1.2.3.zip` already contains the synced `Resources/www` files. It is a source package, not a ready-to-install IPA.

## Refresh bundled web files

When the web UI changes, rebuild the web app and replace `WebSources/Resources/www` with the generated production files before opening the package in Xcode or creating a new release zip. Keep `index.html`, hashed assets, icons, OCR worker files, and OCR language data together so offline import and OCR continue to work.

# CatCheck iOS 包说明

本目录是 CatCheck / 喵喵查寝 的 iOS SwiftPM/WKWebView 包。它内置与 Android v1.2.3 顶部导航版本相同的 Web 构建产物，因此浅青 Material 3 配色、GitHub“加入我们”弹窗，以及“今日 / 历史 / 名单”导航在移动端保持一致。

## 环境要求

- Xcode 15 或更新版本
- iOS 16+ 模拟器或真机
- 真机安装、TestFlight 或 App Store 分发需要 Apple Developer 签名配置

## 目录结构

```text
ios/CatCheck
├── Package.swift
└── WebSources
    ├── CatCheckApp.swift
    └── Resources/www
        └── 内置 CatCheck Web 构建产物
```

`CatCheckApp.swift` 创建 SwiftUI 应用，并通过 WKWebView 加载 `Resources/www/index.html`。运行时不需要启动本地开发服务器。

## 在 Xcode 中运行

1. 用 Xcode 打开 `ios/CatCheck/Package.swift`。
2. 选择 iOS 16+ 模拟器或真机。
3. 如需安装到真机，请在 Xcode 中配置 Team、Bundle Identifier 和签名描述文件。
4. 运行 `CatCheck` target。

GitHub Release 附件 `CatCheck-iOS-M3-TopNav-v1.2.3.zip` 已包含同步好的 `Resources/www` 文件。它是源码包，不是可直接安装的 IPA。

## 刷新内置 Web 文件

当 Web UI 变更时，先重新构建 Web 应用，再用生产构建产物替换 `WebSources/Resources/www`，然后再用 Xcode 打开包或制作新的 release zip。请保持 `index.html`、哈希资源、图标、OCR worker 和 OCR 语言包一起同步，避免离线导入和 OCR 失效。
