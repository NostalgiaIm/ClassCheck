# CatCheck

[![Offline-first](https://img.shields.io/badge/data-offline--first-167d78?style=flat-square)](README.zh-CN.md)
[![Android](https://img.shields.io/badge/Android-10%2B-3ddc84?style=flat-square)](android/)
[![Web](https://img.shields.io/badge/Web-PWA-4f8df7?style=flat-square)](public/manifest.webmanifest)
[![Language](https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-cc4b37?style=flat-square)](README.zh-CN.md)

**English** | [简体中文](README.zh-CN.md)

CatCheck (default Chinese name: **喵喵查寝**) is a mobile-first, offline dormitory attendance tool. It takes attendance by room, starts every room as present, and lets staff change only exceptions. Student data stays on the device.

> This repository contains source code only. APK/AAB files, signing keys, local databases, build output, and update packages are intentionally excluded.

## Features

- Import room number, student name, and class from Excel, CSV, TXT, Markdown, or JSON.
- Extract the same fields from PNG, JPG, and WebP images with on-device OCR, then preview before saving.
- Start a check by entering the checker name, select a room, mark exceptions, add a reason for absent or leave, and save.
- Mark commuting students in the roster without changing attendance records or the final report.
- Generate reports with expected, present, leave counts, and leave names grouped by class.
- Export rosters as XLSX, CSV, Markdown, or JSON; export reports as Markdown, PNG, JPG, or XLSX.
- Keep history, JSON backup and restore, and optionally save to a browser-selected archive directory with download fallback.
- Install as a local Android app through the Kotlin WebView shell, or use the browser/PWA build.

No student number is collected. The roster model is deliberately limited to `roomNo`, `name`, `className`, and the optional local `isCommuter` marker.

## Workflow

```text
Today -> Start check -> Enter checker name -> Choose room
      -> Default all present -> Edit exceptions -> Save / Next room
      -> Finish -> Export report
```

The attendance page is room-scoped. A reason field appears only when the student is set to `Absent` or `Leave`.

## Architecture

```text
Vite web UI
  ├── IndexedDB: roster, sessions, records, settings
  ├── SheetJS: local spreadsheet import/export
  ├── Tesseract.js: bundled Chinese/English OCR assets
  ├── Canvas: PNG/JPG report images
  └── PWA manifest and service worker

Android shell (Kotlin)
  ├── WebView loads bundled web assets
  ├── Android system picker imports local files
  └── MediaStore saves exports to Downloads/喵喵查寝
```

The Android shell targets Android 10+ (API 29), uses an internal WebView URL for packaged assets, and has no network permission in the baseline build. Browser directory selection depends on browser support; a normal file download is used when it is unavailable.

## Run the Web App

```bash
npm ci
npm run dev
```

For another device on the same Wi-Fi:

```bash
npm run dev -- --host 0.0.0.0 --port 5180
```

Use the address printed by Vite. `localhost` only works on the computer running the server.

Build and verify the web app:

```bash
npm run check
```

## Build Android

1. Install Android Studio with JDK 17 and an Android SDK.
2. At repository root, run `npm ci` and `npm run android:assets`.
3. Open the `android/` directory in Android Studio.
4. Build a debug APK from Android Studio, or run Gradle there.

The debug output is normally `android/app/build/outputs/apk/debug/app-debug.apk`. Do not commit that file or any signing material.

See the [mobile architecture note](README-移动端选型.md) and [phone guide](README-手机使用.md) for practical usage.

## Privacy and Data Safety

- Roster, history, OCR, reports, and backup processing are local by design.
- Imports are previewed before they change IndexedDB.
- Input is cleaned, formulas are blocked or escaped for spreadsheet export, and file/text/row limits are applied.
- Clearing site/app data removes unexported local data. Export a JSON backup before changing phones, clearing data, or uninstalling.
- OCR results need human review, especially room number and Chinese names.

## Tests

```bash
npm test
npm run build
```

Test cases, fixtures, and recorded results are in [tests/](tests/README.md). Automated checks cover importer parsing, duplicate/invalid-row handling, formula protection, local asset references, and key workflow wiring. Device-specific behavior such as real downloads, directory permission, and Android installation still needs validation on the target phone.

## Version History

| Version | Summary |
| --- | --- |
| `0.1.0` | Initial offline PWA proof of concept: room-based roster, attendance, history, and local storage. |
| `1.0.0` | Added structured roster import/export, local OCR, report text, JSON backup, and multiple report formats. |
| `1.1.0` | Introduced CatCheck / 喵喵查寝 branding, cat icon, and mobile safe-area work. |
| `1.1.1` | Stabilized Android launch behavior and the embedded WebView startup path. |
| `1.1.2` | Added commuter marking, fixed top navigation, and backup persistence for the marker. |
| `1.1.3` | Refined the two-row top bar and room-management navigation. |
| `1.2.0` | Added self-hosted in-app Android updates with HTTPS manifests, APK size/hash/signature verification, system-confirmed installation, and a local manifest generator. |
| `1.1.4` | Hardened stored state and routes; placed Save / Next directly after the roster; stabilized the checker dialog around the soft keyboard. |

The JavaScript package version remains `0.1.0`; Android `versionCode`/`versionName` identify the installable mobile build. The table records product milestones, not uploaded binary releases.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

Useful contributions include accessibility checks, device testing, better OCR fixtures, import/export edge cases, translations, and focused bug fixes. Do not include real student data, APKs, keys, or local backups in an issue or pull request.

## Project Documents

- [Chinese README](README.zh-CN.md)
- [Phone usage guide](README-手机使用.md)
- [Mobile technology choice](README-移动端选型.md)
- [Test assets and results](tests/README.md)
## In-App Android Updates

The Android app can check a maintainer-controlled HTTPS update manifest from the roster screen. The manifest URL is stored only on the device. The browser/PWA build does not request updates.

Before the app offers installation, it verifies all of the following:

- The manifest and APK URLs use HTTPS without embedded credentials.
- The package name matches `com.nos.classcheck`.
- The candidate version code is higher than the installed version.
- Downloaded APK size and SHA-256 match the manifest.
- The APK signing certificate matches the currently installed app.

Android always shows its own installation confirmation. The app does not perform silent installation.

To publish an update:

1. Increase Android `versionCode` and `versionName`, then build the APK.
2. Obtain the current signing certificate SHA-256 for the release signing key.
3. Generate a manifest:

   ```powershell
   .\tools\publish-update.ps1 -ApkPath .\android\app\build\outputs\apk\release\CatCheck.apk -ApkUrl https://your-host.example/CatCheck.apk -SigningCertSha256 YOUR_64_CHARACTER_CERT_SHA256 -OutputPath .\publish\update.json
   ```

4. Upload `CatCheck.apk` and `update.json` to HTTPS hosting. See [update-manifest.example.json](update-manifest.example.json).
5. In the installed Android app, open “名单”, enter the `update.json` HTTPS URL in “应用更新”, save it, and choose “检查更新”.

For a GitHub Release, use a stable HTTPS URL for the manifest itself. Release asset URLs can host the APK, but the app must always be able to fetch the JSON URL you configured.
