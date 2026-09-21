<div align="center">

<img src="./public/icons/catcheck-icon.png" width="110" height="110" alt="CatCheck 应用图标" />

# CatCheck

### 喵喵查寝

**按寝查寝，数据本地保存，只修改异常人员**

[![Version](https://img.shields.io/badge/Version-v1.2.3-2563EB.svg?style=flat-square&logo=github)](https://github.com/NostalgiaIm/ClassCheck/releases)
[![Platform](https://img.shields.io/badge/Platform-Android%2010%2B-3DDC84.svg?style=flat-square&logo=android)](android/)
[![Web](https://img.shields.io/badge/Web-PWA-4F8DF7.svg?style=flat-square)](public/manifest.webmanifest)
[![Data](https://img.shields.io/badge/Data-%E6%9C%AC%E5%9C%B0%E4%BC%98%E5%85%88-167D78.svg?style=flat-square)](README.md)

<br />

[**English**](README.md) • **简体中文**

<br />

</div>

CatCheck（默认显示中文名：**喵喵查寝**）是一个移动端优先、按宿舍号点名的离线查寝工具。进入一个寝室时默认全到，只需要修改异常人员，学生数据保存在本机。

> 本仓库只保存源码。APK/AAB、签名文件、本地数据库、构建产物和更新安装包均不会提交。

## 功能

- 导入 Excel、CSV、TXT、Markdown、JSON 名单，字段为宿舍号、姓名、班级。
- 本地 OCR 识别 PNG、JPG、WebP 名单图片，识别后先预览再确认。
- 输入查寝人姓名后开始查寝，选择寝室、修改异常、填写原因、保存或继续下一寝。
- 在名单中标记走读学生；走读标记不会写进查寝记录，也不会改变最终汇报。
- 自动生成“X月X日Y寝（查寝人）/ 应到、实到、请假”以及按班级列出的请假人。
- 名单可导出 XLSX、CSV、Markdown、JSON；汇报可导出 Markdown、PNG、JPG、XLSX。
- 本地历史、JSON 备份恢复，以及支持浏览器选择存档目录（不支持时自动下载）。
- 支持浏览器/PWA 使用，也支持 Kotlin Android 离线壳直接安装。

不导入、不保存、不导出学号。名单数据模型只包含 `roomNo`、`name`、`className` 和本地可选的 `isCommuter`（走读）标记。

## 最新移动端安装包

当前可安装移动端版本为 **v1.2.3**。本次把 Android APK 和 iOS WebView 包重绘为设计稿中的浅青 Material 3 界面，同时保留顶部双层导航：应用图标、**喵喵查寝**、圆形 GitHub 入口，以及 **今日 / 历史 / 名单**。GitHub 入口会打开 **加入我们** 弹窗，通过 **查看项目** 按钮跳转仓库，不在界面中直接展示地址。

安装包会随 GitHub Release 上传；本地交付校验值保存在 [`release-archives/v1.2.3-topnav-ui/CHECKSUMS.txt`](release-archives/v1.2.3-topnav-ui/CHECKSUMS.txt)。


## 使用流程

```text
今日 -> 开始查寝 -> 输入查寝人 -> 选择寝室
     -> 默认全到 -> 修改异常 -> 保存 / 下一个寝室
     -> 结束查寝 -> 导出汇报
```

查寝按寝室独立进行。学生状态为“未到”或“请假”时才显示原因输入栏。

## 架构

```text
Vite Web 界面
  ├── IndexedDB：名单、场次、记录、设置
  ├── SheetJS：本地表格导入导出
  ├── Tesseract.js：内置中英文 OCR 资源
  ├── Canvas：PNG/JPG 汇报图片
  └── PWA manifest 与 Service Worker

Android 壳（Kotlin）
  ├── WebView 加载 APK 内置 Web 资源
  ├── 系统文件选择器导入本地文件
  └── MediaStore 保存到 下载/喵喵查寝
```

当前 Android 壳支持 Android 10（API 29）及以上，使用内部 WebView 地址加载资源；基线版本不申请网络权限。浏览器的存档目录能力取决于浏览器支持情况，不能使用时会回退为普通下载。

## 启动网页版

```bash
npm ci
npm run dev
```

同一 Wi-Fi 下让其他设备访问：

```bash
npm run dev -- --host 0.0.0.0 --port 5180
```

请使用 Vite 输出的地址；`localhost` 只能在启动服务的电脑上使用。

构建并检查：

```bash
npm run check
```

## 构建 Android

1. 安装带 JDK 17 和 Android SDK 的 Android Studio。
2. 在项目根目录运行 `npm ci` 与 `npm run android:assets`。
3. 用 Android Studio 打开 `android/` 目录。
4. 从 Android Studio 构建 debug APK，或在该目录运行 Gradle。

调试 APK 通常位于 `android/app/build/outputs/apk/debug/app-debug.apk`。不要提交 APK 或签名材料。

实际手机操作见[手机使用说明](README-手机使用.md)，技术取舍见[移动端选型](README-移动端选型.md)。

## 隐私与数据整洁性

- 名单、历史、OCR、汇报与备份处理均在本机进行。
- 导入必须先预览，确认后才会写入 IndexedDB。
- 输入会清理，表格公式会被拦截或转义；同时限制文件、文本和行数。
- 清理站点/应用数据会删除未备份内容；换手机、清数据或卸载前，请先导出 JSON 备份。
- OCR 的宿舍号和姓名需要人工复核。

## 应用内更新（Android）

Android 安装包在原生代码中固定了官方 HTTPS 更新清单地址。用户只需在“名单”页点击“检查更新”，不会看到、填写或保存更新地址；浏览器/PWA 版本不会检查应用更新。

检查时会验证 HTTPS、包名、递增版本号、APK 文件大小、SHA-256 与签名证书；安装仍由 Android 系统确认。名单、查寝记录、导出文件和本地备份不会随更新请求上传。

维护者发布更新时，需要提高 Android `versionCode`/`versionName`，生成 APK 和对应清单，并更新固定清单地址指向的 JSON 文件。
## 测试

```bash
npm test
npm run build
```

测试用例、样本和执行结果在 [tests/](tests/README.md)。自动化检查覆盖解析、重复/异常行、公式防护、本地资源引用和关键流程接线。真实手机下载、目录权限、Android 安装等行为仍应在目标手机上复测。

## 版本记录

| 版本 | 概要 |
| --- | --- |
| `1.2.3` | 将 Android APK 与 iOS WebView 包重绘为设计稿中的浅青 Material 3 界面，保留顶部双层导航，并加入 GitHub“加入我们”弹窗和“查看项目”按钮。 |
| `1.2.1` | 将官方更新清单固定在 Android 原生代码中，移除用户可编辑的更新地址，同时保留 HTTPS、APK 大小/哈希/签名校验与系统确认安装。 |
| `1.2.0` | 加入自建应用内更新：HTTPS 更新清单、APK 大小/哈希/签名校验、系统确认安装和本地发布清单生成脚本。 |
| `1.1.4` | 加固本地状态与路由；保存/下一寝紧贴名单末尾；改善输入法下的查寝人弹窗稳定性。 |
| `1.1.3` | 调整双层顶栏与名单页寝室管理导航。 |
| `1.1.2` | 加入走读标记、固定顶部导航，并让走读标记随备份保存。 |
| `1.1.1` | 稳定 Android 启动和内置 WebView 加载路径。 |
| `1.1.0` | 改为 CatCheck / 喵喵查寝品牌，加入猫咪图标和移动端安全区适配。 |
| `1.0.0` | 加入结构化名单导入导出、本地 OCR、汇报文字、JSON 备份和多格式汇报。 |
| `0.2.0` | Material Design 3 重构完成：语义化设计令牌、排版、阴影和组件样式。新增离线 OCR 资源缓存、改进 PWA Service Worker，以及存储配额管理。 |
| `0.1.0` | 初始离线 PWA 原型：按寝名单、点名、历史、本地存储。 |

JavaScript 包版本（`0.x.x`）现已独立于 Android 产品版本；详见 [CHANGELOG.md](CHANGELOG.md)。Android 的 `versionCode`/`versionName` 用于标识可安装的移动版本。表格记录的是产品里程碑，并不代表上传二进制安装包。

## 贡献

欢迎提交贡献。提交 issue 或 pull request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

特别需要：无障碍检查、真机测试、OCR 样本改进、导入导出边界用例、翻译和聚焦的 Bug 修复。请勿在 issue 或 PR 中提交真实学生数据、APK、签名文件或本地备份。

## 项目文档

- [English README](README.md)
- [手机使用说明](README-手机使用.md)
- [移动端选型](README-移动端选型.md)
- [测试资料与结果](tests/README.md)
