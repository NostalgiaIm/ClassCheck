package com.nos.classcheck

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

class UpdateManager(private val context: Context) {
    private val executor = Executors.newSingleThreadExecutor()
    private val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val inProgress = AtomicBoolean(false)

    fun appInfoJson(): String = JSONObject()
        .put("packageName", context.packageName)
        .put("versionCode", versionCodeOf(currentPackageInfo()))
        .put("versionName", currentPackageInfo().versionName ?: "")
        .put("signingCertSha256", currentSigningHashes().sorted().joinToString(","))
        .toString()

    fun statusJson(): String = JSONObject()
        .put("state", preferences.getString(KEY_STATE, STATE_IDLE) ?: STATE_IDLE)
        .put("message", preferences.getString(KEY_MESSAGE, "尚未检查更新") ?: "")
        .toString()

    fun check(): String {
        if (!isSafeHttpsUrl(UPDATE_MANIFEST_URL, MAX_MANIFEST_URL_LENGTH)) {
            saveStatus(context, STATE_ERROR, "更新清单必须使用安全的 HTTPS 地址")
            return statusJson()
        }
        if (!inProgress.compareAndSet(false, true)) return statusJson()

        saveStatus(context, STATE_CHECKING, "正在检查更新")
        executor.execute {
            try {
                val manifest = fetchManifest(UPDATE_MANIFEST_URL)
                if (manifest.versionCode <= versionCodeOf(currentPackageInfo())) {
                    deletePendingApk()
                    clearManifest()
                    saveStatus(context, STATE_IDLE, "已是最新版本 " + (currentPackageInfo().versionName ?: ""))
                    return@execute
                }
                saveManifest(manifest)
                saveStatus(context, STATE_DOWNLOADING, "正在下载 " + manifest.versionName)
                downloadAndVerify(manifest)
                saveStatus(context, STATE_READY, manifest.versionName + " 已验证，可安装")
            } catch (error: Exception) {
                Log.w(TAG, "Update check failed", error)
                deletePendingApk()
                clearManifest()
                saveStatus(context, STATE_ERROR, userMessage(error))
            } finally {
                inProgress.set(false)
            }
        }
        return statusJson()
    }

    fun install(): String {
        val manifest = loadManifest()
        val apk = pendingApk()
        if (manifest == null || !apk.isFile) {
            saveStatus(context, STATE_ERROR, "没有已验证的更新，请先检查更新")
            return statusJson()
        }

        if (!inProgress.compareAndSet(false, true)) return statusJson()
        saveStatus(context, STATE_INSTALLING, "正在准备系统安装")
        executor.execute {
            try {
                verifyApk(apk, manifest)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
                    val settingsIntent = Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + context.packageName),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    context.startActivity(settingsIntent)
                    saveStatus(context, STATE_ERROR, "请允许“喵喵查寝”安装更新后重试")
                    return@execute
                }
                requestInstall(apk, manifest)
                saveStatus(context, STATE_INSTALLING, "请在系统窗口确认安装")
            } catch (error: Exception) {
                Log.w(TAG, "Update install failed", error)
                saveStatus(context, STATE_ERROR, userMessage(error))
            } finally {
                inProgress.set(false)
            }
        }
        return statusJson()
    }

    private fun fetchManifest(manifestUrl: String): UpdateManifest {
        val connection = secureConnection(manifestUrl, MAX_MANIFEST_URL_LENGTH)
        try {
            val payload = JSONObject(readLimited(connection, MAX_MANIFEST_BYTES).toString(Charsets.UTF_8))
            if (payload.optString("format") != MANIFEST_FORMAT) {
                throw UpdateError("更新清单格式不受支持")
            }

            val versionCode = payload.optLong("versionCode", -1)
            val versionName = payload.optString("versionName").trim()
            val packageName = payload.optString("packageName").trim()
            val apkUrl = payload.optString("apkUrl").trim()
            val sha256 = payload.optString("sha256").trim().uppercase(Locale.ROOT)
            val certificate = payload.optString("signingCertSha256").trim().uppercase(Locale.ROOT)
            val size = payload.optLong("size", -1)

            if (versionCode <= 0 || versionName.isBlank() || versionName.length > 50) {
                throw UpdateError("更新版本信息无效")
            }
            if (packageName != context.packageName) throw UpdateError("更新包名与当前应用不一致")
            if (!isSafeHttpsUrl(apkUrl, MAX_APK_URL_LENGTH)) throw UpdateError("更新 APK 地址必须使用 HTTPS")
            if (!isSha256(sha256) || !isSha256(certificate)) throw UpdateError("更新清单缺少有效校验值")
            if (size !in 1..MAX_APK_BYTES) throw UpdateError("更新文件大小无效")
            if (!currentSigningHashes().contains(certificate)) throw UpdateError("更新签名与当前应用不匹配")

            return UpdateManifest(versionCode, versionName, packageName, apkUrl, sha256, certificate, size)
        } finally {
            connection.disconnect()
        }
    }

    private fun downloadAndVerify(manifest: UpdateManifest) {
        val target = pendingApk()
        target.parentFile?.mkdirs()
        target.delete()
        val temporary = File(target.parentFile, target.name + ".part")
        temporary.delete()

        val connection = secureConnection(manifest.apkUrl, MAX_APK_URL_LENGTH)
        try {
            val declaredSize = connection.contentLengthLong
            if (declaredSize > MAX_APK_BYTES || (declaredSize >= 0 && declaredSize != manifest.size)) {
                throw UpdateError("下载文件大小与更新清单不一致")
            }

            val digest = MessageDigest.getInstance("SHA-256")
            var total = 0L
            BufferedInputStream(connection.inputStream).use { input ->
                temporary.outputStream().buffered().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > MAX_APK_BYTES || total > manifest.size) throw UpdateError("下载文件超过允许大小")
                        digest.update(buffer, 0, count)
                        output.write(buffer, 0, count)
                    }
                }
            }
            if (total != manifest.size || digest.digest().toHex() != manifest.sha256) {
                throw UpdateError("下载文件校验失败")
            }
            if (!temporary.renameTo(target)) throw UpdateError("无法保存更新文件")
            verifyApk(target, manifest)
        } finally {
            temporary.delete()
            connection.disconnect()
        }
    }

    private fun verifyApk(apk: File, manifest: UpdateManifest) {
        if (!apk.isFile || apk.length() != manifest.size || sha256Of(apk) != manifest.sha256) {
            throw UpdateError("本地更新文件校验失败")
        }
        val archive = packageInfoForArchive(apk) ?: throw UpdateError("更新文件不是有效 APK")
        if (archive.packageName != manifest.packageName) throw UpdateError("更新 APK 包名不匹配")
        if (versionCodeOf(archive) != manifest.versionCode || archive.versionName != manifest.versionName) {
            throw UpdateError("更新 APK 版本不匹配")
        }

        val current = currentSigningHashes()
        val archived = signingHashes(archive)
        if (archived.isEmpty() || archived != current || !archived.contains(manifest.signingCertSha256)) {
            throw UpdateError("更新 APK 签名不匹配")
        }
    }

    private fun requestInstall(apk: File, manifest: UpdateManifest) {
        val installer = context.packageManager.packageInstaller
        val parameters = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(manifest.packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
            }
        }
        val sessionId = installer.createSession(parameters)
        try {
            installer.openSession(sessionId).use { session ->
                FileInputStream(apk).use { input ->
                    session.openWrite("CatCheck.apk", 0, apk.length()).use { output ->
                        input.copyTo(output)
                        session.fsync(output)
                    }
                }
                val callback = Intent(context, UpdateInstallReceiver::class.java)
                    .setAction(UpdateInstallReceiver.ACTION_INSTALL_STATUS)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or mutablePendingIntentFlag()
                val pendingIntent = PendingIntent.getBroadcast(context, sessionId, callback, flags)
                session.commit(pendingIntent.intentSender)
            }
        } catch (error: Exception) {
            installer.abandonSession(sessionId)
            throw error
        }
    }

    private fun secureConnection(rawUrl: String, maximumLength: Int): HttpURLConnection {
        var candidate = rawUrl
        repeat(MAX_REDIRECTS + 1) {
            if (!isSafeHttpsUrl(candidate, maximumLength)) throw UpdateError("更新地址不安全")
            val connection = (URL(candidate).openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                useCaches = false
                setRequestProperty("Accept", "application/json, application/vnd.android.package-archive, */*")
            }
            when (val code = connection.responseCode) {
                HttpURLConnection.HTTP_OK -> return connection
                in 300..399 -> {
                    val location = connection.getHeaderField("Location")
                    connection.disconnect()
                    if (location.isNullOrBlank()) throw UpdateError("更新地址重定向无效")
                    candidate = URL(URL(candidate), location).toString()
                }
                else -> {
                    connection.disconnect()
                    throw UpdateError("更新服务器返回错误 " + code)
                }
            }
        }
        throw UpdateError("更新地址重定向次数过多")
    }

    private fun readLimited(connection: HttpURLConnection, maximumBytes: Int): ByteArray {
        if (connection.contentLengthLong > maximumBytes) throw UpdateError("更新清单过大")
        val output = ByteArrayOutputStream()
        BufferedInputStream(connection.inputStream).use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                if (output.size() + count > maximumBytes) throw UpdateError("更新清单过大")
                output.write(buffer, 0, count)
            }
        }
        return output.toByteArray()
    }

    private fun currentPackageInfo(): PackageInfo {
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.packageManager.getPackageInfo(
                context.packageName,
                PackageManager.PackageInfoFlags.of(flags.toLong()),
            )
        } else {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, flags)
        }
    }

    private fun packageInfoForArchive(apk: File): PackageInfo? {
        val flags = PackageManager.GET_SIGNING_CERTIFICATES
        val manager = context.packageManager
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            manager.getPackageArchiveInfo(apk.path, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION")
            manager.getPackageArchiveInfo(apk.path, flags)
        }
        info?.applicationInfo?.apply {
            sourceDir = apk.path
            publicSourceDir = apk.path
        }
        return info
    }

    private fun versionCodeOf(info: PackageInfo): Long {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else {
            @Suppress("DEPRECATION")
            info.versionCode.toLong()
        }
    }

    private fun currentSigningHashes(): Set<String> = signingHashes(currentPackageInfo())

    private fun signingHashes(info: PackageInfo): Set<String> {
        val signingInfo = info.signingInfo ?: return emptySet()
        val signatures = if (signingInfo.hasMultipleSigners()) {
            signingInfo.apkContentsSigners
        } else {
            signingInfo.signingCertificateHistory
        }
        return signatures.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).toHex()
        }.toSet()
    }

    private fun sha256Of(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().toHex()
    }

    private fun saveManifest(manifest: UpdateManifest) {
        preferences.edit()
            .putString(KEY_APK_URL, manifest.apkUrl)
            .putString(KEY_SHA256, manifest.sha256)
            .putString(KEY_CERTIFICATE, manifest.signingCertSha256)
            .putString(KEY_VERSION_NAME, manifest.versionName)
            .putLong(KEY_VERSION_CODE, manifest.versionCode)
            .putLong(KEY_SIZE, manifest.size)
            .apply()
    }

    private fun loadManifest(): UpdateManifest? {
        val apkUrl = preferences.getString(KEY_APK_URL, null) ?: return null
        val sha256 = preferences.getString(KEY_SHA256, null) ?: return null
        val certificate = preferences.getString(KEY_CERTIFICATE, null) ?: return null
        val versionName = preferences.getString(KEY_VERSION_NAME, null) ?: return null
        val versionCode = preferences.getLong(KEY_VERSION_CODE, -1)
        val size = preferences.getLong(KEY_SIZE, -1)
        if (
            !isSafeHttpsUrl(apkUrl, MAX_APK_URL_LENGTH)
            || !isSha256(sha256)
            || !isSha256(certificate)
            || versionCode <= versionCodeOf(currentPackageInfo())
            || size !in 1..MAX_APK_BYTES
        ) return null
        return UpdateManifest(versionCode, versionName, context.packageName, apkUrl, sha256, certificate, size)
    }

    private fun clearManifest() {
        preferences.edit()
            .remove(KEY_APK_URL)
            .remove(KEY_SHA256)
            .remove(KEY_CERTIFICATE)
            .remove(KEY_VERSION_NAME)
            .remove(KEY_VERSION_CODE)
            .remove(KEY_SIZE)
            .apply()
    }

    private fun pendingApk(): File = File(File(context.cacheDir, UPDATE_DIRECTORY), PENDING_APK_NAME)

    private fun deletePendingApk() {
        pendingApk().delete()
        File(pendingApk().parentFile, PENDING_APK_NAME + ".part").delete()
    }


    private fun userMessage(error: Exception): String {
        return (error as? UpdateError)?.message ?: "更新失败，请检查网络和更新清单"
    }

    private fun mutablePendingIntentFlag(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    }

    private data class UpdateManifest(
        val versionCode: Long,
        val versionName: String,
        val packageName: String,
        val apkUrl: String,
        val sha256: String,
        val signingCertSha256: String,
        val size: Long,
    )

    private class UpdateError(message: String) : Exception(message)

    companion object {
        private const val TAG = "CatCheckUpdate"
        private const val PREFERENCES = "catcheck_update"
        private const val KEY_STATE = "state"
        private const val KEY_MESSAGE = "message"
        private const val KEY_APK_URL = "apkUrl"
        private const val KEY_SHA256 = "sha256"
        private const val KEY_CERTIFICATE = "certificate"
        private const val KEY_VERSION_NAME = "versionName"
        private const val KEY_VERSION_CODE = "versionCode"
        private const val KEY_SIZE = "size"
        private const val STATE_IDLE = "idle"
        private const val STATE_CHECKING = "checking"
        private const val STATE_DOWNLOADING = "downloading"
        private const val STATE_READY = "ready"
        private const val STATE_INSTALLING = "installing"
        private const val STATE_ERROR = "error"
        private const val MANIFEST_FORMAT = "catcheck-update-v1"
        private const val UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/NostalgiaIm/ClassCheck/Tedab/updates/latest.json"
        private const val UPDATE_DIRECTORY = "catcheck-update"
        private const val PENDING_APK_NAME = "CatCheck.apk"
        private const val MAX_MANIFEST_URL_LENGTH = 500
        private const val MAX_APK_URL_LENGTH = 4096
        private const val MAX_MANIFEST_BYTES = 64 * 1024
        private const val MAX_APK_BYTES = 120L * 1024L * 1024L
        private const val MAX_REDIRECTS = 4
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000

        internal fun saveStatus(context: Context, state: String, message: String) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_STATE, state)
                .putString(KEY_MESSAGE, message.take(160))
                .apply()
        }

        private fun isSafeHttpsUrl(value: String, maximumLength: Int): Boolean {
            if (value.isBlank() || value.length > maximumLength) return false
            return try {
                val uri = URI(value)
                uri.scheme.equals("https", ignoreCase = true)
                    && !uri.host.isNullOrBlank()
                    && uri.userInfo.isNullOrBlank()
            } catch (_: Exception) {
                false
            }
        }

        private fun isSha256(value: String): Boolean = value.matches(Regex("^[A-F0-9]{64}$"))

        private fun ByteArray.toHex(): String = joinToString("") { "%02X".format(Locale.ROOT, it) }
    }
}

