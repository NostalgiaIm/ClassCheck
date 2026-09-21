package com.nos.classcheck

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import android.view.WindowManager
import java.io.IOException
import java.util.Base64

class MainActivity : Activity() {
    private val updateManager by lazy { UpdateManager(this) }
    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var navigationBarInsetBottom = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this)
        // Keep the centered start-check dialog stable while the soft keyboard is visible.
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING)
        webView.setBackgroundColor(Color.rgb(238, 246, 244))
        webView.setOnApplyWindowInsetsListener { _, insets ->
            @Suppress("DEPRECATION")
            navigationBarInsetBottom = insets.systemWindowInsetBottom
            applyNavigationInset()
            insets
        }
        configureWebView(webView)
        setContentView(webView)
        webView.requestApplyInsets()
        webView.loadUrl(APP_URL)
    }

    private fun configureWebView(view: WebView) {
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        view.webViewClient = object : LocalAssetWebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                applyNavigationInset()
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                params: FileChooserParams?,
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback

                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, SUPPORTED_MIME_TYPES)
                    putExtra(Intent.EXTRA_ALLOW_MULTIPLE, false)
                }
                startActivityForResult(intent, FILE_CHOOSER_REQUEST)
                return true
            }
        }
        view.addJavascriptInterface(AndroidFileBridge(), "AndroidFileBridge")
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != FILE_CHOOSER_REQUEST) return
        val result = if (resultCode == RESULT_OK && data?.data != null) {
            arrayOf(data.data!!)
        } else {
            null
        }
        filePathCallback?.onReceiveValue(result)
        filePathCallback = null
    }

    override fun onBackPressed() {
        if (webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    private fun applyNavigationInset() {
        if (!::webView.isInitialized || webView.url.isNullOrBlank()) return
        webView.evaluateJavascript(
            "document.documentElement.style.setProperty('--native-bottom-inset', '${navigationBarInsetBottom}px');",
            null,
        )
    }

    private open inner class LocalAssetWebViewClient : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
            val uri = request?.url ?: return null
            if (uri.host != ASSET_HOST) return null
            val path = uri.path.orEmpty().removePrefix("/").ifBlank { "index.html" }
            return openAsset(path)
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val uri = request?.url ?: return false
            if (uri.host == ASSET_HOST) return false
            if (uri.scheme == "http" || uri.scheme == "https") {
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (_: Exception) {
                    Toast.makeText(this@MainActivity, "无法打开项目链接", Toast.LENGTH_SHORT).show()
                }
            }
            return true
        }

        private fun openAsset(path: String): WebResourceResponse? {
            if (path.contains("..") || path.startsWith("\\")) return null
            return try {
                val input = assets.open("$ASSET_ROOT/$path")
                WebResourceResponse(mimeType(path), null, input)
            } catch (_: IOException) {
                null
            }
        }
    }

    private inner class AndroidFileBridge {
        @JavascriptInterface
        fun saveFile(filename: String, mimeType: String, dataUrl: String): String {
            return try {
                val base64 = dataUrl.substringAfter(',', "")
                if (base64.isBlank() || base64.length > MAX_BASE64_LENGTH) return "error"
                val bytes = Base64.getDecoder().decode(base64)
                val safeName = sanitizeFilename(filename)
                val values = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, safeName)
                    put(MediaStore.Downloads.MIME_TYPE, mimeType.ifBlank { "application/octet-stream" })
                    put(MediaStore.Downloads.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/喵喵查寝")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val resolver = contentResolver
                val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: return "error"
                try {
                    resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("cannot open output")
                    values.clear()
                    values.put(MediaStore.Downloads.IS_PENDING, 0)
                    resolver.update(uri, values, null, null)
                    runOnUiThread { Toast.makeText(this@MainActivity, "文件已保存到下载/喵喵查寝", Toast.LENGTH_SHORT).show() }
                    "saved"
                } catch (error: Exception) {
                    resolver.delete(uri, null, null)
                    throw error
                }
            } catch (_: Exception) {
                "error"
            }
        }


        @JavascriptInterface
        fun getAppInfo(): String = updateManager.appInfoJson()

        @JavascriptInterface
        fun getUpdateStatus(): String = updateManager.statusJson()

        @JavascriptInterface
        fun checkForUpdate(): String = updateManager.check()

        @JavascriptInterface
        fun installAvailableUpdate(): String = updateManager.install()
    }

    private fun sanitizeFilename(value: String): String {
        val cleaned = value.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim()
        return cleaned.take(120).ifBlank { "喵喵查寝导出文件" }
    }

    private fun mimeType(path: String): String {
        return when (path.substringAfterLast('.', "").lowercase()) {
            "js" -> "application/javascript"
            "css" -> "text/css"
            "html" -> "text/html"
            "json", "webmanifest" -> "application/json"
            "png" -> "image/png"
            "jpg", "jpeg" -> "image/jpeg"
            "svg" -> "image/svg+xml"
            "gz" -> "application/gzip"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.substringAfterLast('.'))
                ?: "application/octet-stream"
        }
    }

    companion object {
        private const val APP_URL = "https://appassets.localhost/index.html"
        private const val ASSET_HOST = "appassets.localhost"
        private const val ASSET_ROOT = "www"
        private const val FILE_CHOOSER_REQUEST = 4101
        private const val MAX_BASE64_LENGTH = 50 * 1024 * 1024
        private val SUPPORTED_MIME_TYPES = arrayOf(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-excel",
            "text/csv",
            "text/plain",
            "text/markdown",
            "application/json",
            "image/png",
            "image/jpeg",
            "image/webp",
        )
    }
}
