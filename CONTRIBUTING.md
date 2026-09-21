# Contributing to CatCheck

[中文说明](#中文说明)

Thanks for helping improve CatCheck. Small, focused changes are easiest to review.

## Before You Start

1. Search existing issues before opening a new one.
2. Never add real student names, room assignments, APK/AAB files, signing keys, or local backups.
3. Keep the app usable without an account and without a server for its core attendance workflow.
4. Run `npm test` and `npm run build` before submitting a change to web code.

## Pull Requests

- Describe the user-facing behavior and how you tested it.
- Confirm the PR template checklist before submitting.
- Keep unrelated formatting or refactors out of the same pull request.
- Add or update a fixture and test case when fixing import, export, report, or state behavior.
- Do not commit real student data, screenshots with personal information, APK/AAB/IPA files, signing keys, local backups, or private configuration.
- Test Android-facing or iOS-facing changes on a device when possible; state clearly when the test is static, simulator-only, or emulator-only.

## Development

```bash
npm ci
npm run dev
npm test
npm run build
```

For Android assets, run `npm run android:assets`, then open `android/` in Android Studio. Generated Android assets, build output, and APKs are ignored by Git.

## 中文说明

感谢参与 CatCheck。请保持改动聚焦，并注意：

- 不要提交真实学生信息、寝室信息、含个人信息的截图、APK/AAB/IPA、签名文件、本地备份或私有配置。
- 核心查寝流程必须保持无账号、无服务器也可使用。
- 修改 Web、移动端包或构建相关代码后运行 `npm test` 和 `npm run build`。
- PR 请说明用户可见变化、测试方式及未验证项，并确认 PR 模板中的检查清单。
- 涉及导入、导出、汇报或状态逻辑时，请补充对应测试用例或样本，且样本只能使用虚构数据。

