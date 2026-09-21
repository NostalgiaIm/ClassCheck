# Security Policy

CatCheck / 喵喵查寝 is an offline-first attendance tool that may be used with sensitive roster and attendance data. Please report security issues privately and use synthetic sample data whenever possible.

## Supported versions

Security fixes are handled for the latest published release and the current development branch.

| Version | Supported |
| --- | --- |
| Latest GitHub Release | Yes |
| Current `Tedab` branch | Yes |
| Older releases | Best effort only |

## Reporting a vulnerability

Please do not open a public GitHub Issue for vulnerabilities, privacy problems, real rosters, attendance records, keys, signing files, or exploit details.

Use GitHub's private vulnerability reporting or security advisory flow when available: <https://github.com/NostalgiaIm/ClassCheck/security/advisories/new>

If private reporting is not available to you, contact the maintainer through their GitHub profile first and request a private channel. In any public message, include only a short, non-sensitive summary such as "I need to report a private security issue". Do not attach screenshots, rosters, backups, APK signing material, or logs containing real student data.

A useful report includes:

- affected version or commit;
- platform, such as Android APK, iOS WKWebView package, browser/PWA, or local development build;
- clear reproduction steps using fake data only;
- expected and actual behavior;
- impact, such as local data exposure, formula injection bypass, unsafe file import/export, update verification bypass, or XSS;
- any workaround you have found.

The maintainer will try to acknowledge reports within 7 days and will coordinate fixes before public disclosure.

# 安全政策

CatCheck / 喵喵查寝是本地优先的查寝工具，可能会被用于处理敏感名单和查寝数据。请私下报告安全问题，并尽量只使用虚构样本数据。

## 支持范围

安全修复优先覆盖最新 GitHub Release 和当前开发分支。

| 版本 | 支持状态 |
| --- | --- |
| 最新 GitHub Release | 支持 |
| 当前 `Tedab` 分支 | 支持 |
| 更早版本 | 尽力处理 |

## 报告漏洞

请不要用公开 Issue 提交漏洞细节、隐私问题、真实名单、查寝记录、密钥、签名文件或可利用细节。

优先使用 GitHub 的私密漏洞报告或安全通告流程：<https://github.com/NostalgiaIm/ClassCheck/security/advisories/new>

如果你无法使用私密报告，请先通过维护者 GitHub 主页联系并请求私密沟通渠道。任何公开留言都只写不含敏感信息的简短说明，例如“我需要私下报告一个安全问题”。不要附带真实名单、备份、截图、APK 签名材料或包含学生数据的日志。
