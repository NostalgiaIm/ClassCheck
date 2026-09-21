# CatCheck v1.2.3 顶部导航 UI 更新

本次更新把 APK 与 iOS 包同步到截图风格的浅青 Material 3 界面，并保留顶部双层导航。

## 更新内容

- 顶部第一层为应用图标、标题“喵喵查寝”和圆形 GitHub 入口。
- 顶部第二层保留“今日 / 历史 / 名单”三个栏目。
- GitHub 入口弹出“加入我们”，用“查看项目”按钮打开项目仓库，不直接展示地址。
- 首页、查寝、历史、名单页统一为浅青背景、青绿色主色、圆角模块和卡片式布局。
- APK 内的外部项目链接会交给系统浏览器打开。

## 交付文件

- `files/CatCheck-M3-TopNav-v1.2.3.apk`：Android 10+ 安装包。
- `files/CatCheck-iOS-M3-TopNav-v1.2.3.zip`：iOS SwiftPM/WKWebView 源码包，内置同步后的 Web 资源。

## iOS 包使用说明

解压 `CatCheck-iOS-M3-TopNav-v1.2.3.zip` 后，用 Xcode 15 或更新版本打开其中的 `ios/CatCheck/Package.swift`。该包支持 iOS 16+，通过 WKWebView 加载内置 `Resources/www/index.html`，不需要运行开发服务器。真机安装、TestFlight 或 App Store 分发需要维护者在 Xcode 中配置自己的 Apple Developer 团队和签名。

校验值见 `CHECKSUMS.txt`。源码提交不会包含 APK/zip；这些文件用于本地归档和 GitHub Release 附件。
