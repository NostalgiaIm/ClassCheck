<div align="center">

<img src="./public/icons/catcheck-icon.png" width="110" height="110" alt="CatCheck app icon" />

# CatCheck

### Room-by-room dormitory attendance for mobile

**Local-first, fast, and built for exception-only check-ins**

[![Release](https://img.shields.io/badge/Release-v1.2.4-2563EB.svg?style=flat-square&logo=github)](https://github.com/NostalgiaIm/CatCheck/releases/tag/v1.2.4)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square)](LICENSE)
[![Android](https://img.shields.io/badge/Android-10%2B-3DDC84.svg?style=flat-square&logo=android)](android/)
[![iOS](https://img.shields.io/badge/iOS-16%2B-000000.svg?style=flat-square&logo=apple)](ios/CatCheck/)
[![Web](https://img.shields.io/badge/Web-PWA-4F8DF7.svg?style=flat-square)](public/manifest.webmanifest)
[![Data](https://img.shields.io/badge/Data-Offline--first-167D78.svg?style=flat-square)](README.zh-CN.md)

<br />

**English** • [**简体中文**](README.zh-CN.md)

<br />

</div>

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
- Install through the local Android WebView shell, run the iOS SwiftPM/WKWebView package, or use the browser/PWA build.

No student number is collected. The roster model is deliberately limited to `roomNo`, `name`, `className`, and the optional local `isCommuter` marker.

## Latest Mobile Build

The current installable mobile build is **v1.2.4**. This maintenance release keeps the v1.2.3 pale-teal Material 3 Android/iOS UI and updates the project destination, release metadata, and in-app update source to the CatCheck repository. The GitHub entry still opens a **Join us** dialog and exposes the repository through a **View project** button.

The published [GitHub Release v1.2.4](https://github.com/NostalgiaIm/CatCheck/releases/tag/v1.2.4) contains the Android APK and iOS SwiftPM/WKWebView package for this repository.

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

iOS package (SwiftPM + WKWebView)
  ├── SwiftUI app entry in ios/CatCheck/WebSources
  ├── WKWebView loads bundled www/index.html
  └── Bundled web resources mirror the Android APK UI
```

The Android shell targets Android 10+ (API 29), uses an internal WebView URL for packaged assets, and has no network permission in the baseline build. Browser directory selection depends on browser support; a normal file download is used when it is unavailable.

The iOS package targets iOS 16+, is opened from [`ios/CatCheck/Package.swift`](ios/CatCheck/Package.swift), and loads the bundled web build from `ios/CatCheck/WebSources/Resources/www` through WKWebView. The release zip is a source package; signing, provisioning, TestFlight, and App Store distribution are handled in Xcode with the maintainer's Apple Developer account.

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

## Build iOS

1. Install Xcode 15 or newer.
2. Use the release asset `CatCheck-iOS-v1.2.4.zip` for the ready iOS source package, or build the web app and sync the generated files into `ios/CatCheck/WebSources/Resources/www`.
3. Open [`ios/CatCheck/Package.swift`](ios/CatCheck/Package.swift) in Xcode.
4. Select an iOS 16+ simulator or device, then run and sign it with your Apple Developer team for device installation, TestFlight, or App Store delivery.

See the [mobile architecture note](README-移动端选型.md), [phone guide](README-手机使用.md), and [iOS package README](ios/CatCheck/README.md) for practical usage.

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
| `1.2.4` | Migrated project links, update metadata, and the in-app GitHub destination to the CatCheck repository; refreshed the Android/iOS release package references. |
| `1.2.3` | Repainted the Android APK and iOS WebView package to match the pale-teal Material 3 mockups, kept the two-row top navigation, and added the GitHub "Join us" dialog with a "View project" button. |
| `1.2.1` | Made the official update manifest a fixed Android setting, removed the editable update address, and retained HTTPS, APK size/hash/signature checks, and system-confirmed installation. |
| `1.2.0` | Added self-hosted in-app Android updates with HTTPS manifests, APK size/hash/signature verification, system-confirmed installation, and a local manifest generator. |
| `1.1.4` | Hardened stored state and routes; placed Save / Next directly after the roster; stabilized the checker dialog around the soft keyboard. |
| `1.1.3` | Refined the two-row top bar and room-management navigation. |
| `1.1.2` | Added commuter marking, fixed top navigation, and backup persistence for the marker. |
| `1.1.1` | Stabilized Android launch behavior and the embedded WebView startup path. |
| `1.1.0` | Introduced CatCheck / 喵喵查寝 branding, cat icon, and mobile safe-area work. |
| `1.0.0` | Added structured roster import/export, local OCR, report text, JSON backup, and multiple report formats. |
| `0.2.0` | Material Design 3 redesign: semantic color tokens, typography, shadows, and components. Added offline OCR resource caching, improved PWA service worker, and storage quota management. |
| `0.1.0` | Initial offline PWA proof of concept: room-based roster, attendance, history, and local storage. |

The JavaScript package version (`0.x.x`) now tracks web/PWA releases independently; see [CHANGELOG.md](CHANGELOG.md) for details. Android `versionCode`/`versionName` identify the installable mobile build. The table records product milestones, not uploaded binary releases.

## License

CatCheck is released under the [MIT License](LICENSE).

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request.

Useful contributions include accessibility checks, device testing, better OCR fixtures, import/export edge cases, translations, and focused bug fixes. Do not include real student data, APKs, keys, or local backups in an issue or pull request.

## Project Documents

- [Chinese README](README.zh-CN.md)
- [Phone usage guide](README-手机使用.md)
- [Mobile technology choice](README-移动端选型.md)
- [iOS SwiftPM package](ios/CatCheck/)
- [Test assets and results](tests/README.md)

## In-App Android Updates

The Android app checks a fixed, maintainer-controlled HTTPS update manifest from the roster screen. Users only choose “Check for updates”; no editable manifest address is shown, stored, or passed from the web UI. The browser/PWA build does not request updates.

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
5. Publish the manifest at the HTTPS location compiled into the Android app. In the installed Android app, open “名单” and choose “检查更新”.

For a GitHub Release, use a stable HTTPS URL for the manifest itself. Release asset URLs can host the APK, but the app must always be able to fetch the JSON URL compiled into the Android app.
