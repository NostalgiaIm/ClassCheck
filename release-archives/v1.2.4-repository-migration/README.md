# CatCheck v1.2.4 repository migration archive

This archive records the `v1.2.4` migration from the former ClassCheck repository address to `https://github.com/NostalgiaIm/CatCheck`.

## Changes

- Updated the in-app GitHub entry and its **Join us / View project** flow.
- Updated README badges, release links, security links, update-manifest source, and GitHub issue configuration.
- Updated the Android app to `versionCode 11` / `versionName 1.2.4` and refreshed bundled WebView assets for Android and iOS.
- Published the Android APK and iOS SwiftPM/WKWebView source package as GitHub Release assets.

## Release files

- `files/CatCheck.apk`: Android 10+ APK, signed with the same Android Debug certificate used by the previous update package.
- `files/CatCheck-iOS-v1.2.4.zip`: iOS 16+ SwiftPM/WKWebView source package with bundled web resources.

The binaries are kept out of Git history. `CHECKSUMS.txt` contains the SHA-256 values and byte sizes used for the release and Android update manifest.