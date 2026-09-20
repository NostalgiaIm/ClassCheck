package com.nos.classcheck

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller

class UpdateInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirmation = if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                confirmation?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let(context::startActivity)
                UpdateManager.saveStatus(context, "installing", "请在系统窗口确认安装")
            }
            PackageInstaller.STATUS_SUCCESS -> {
                UpdateManager.saveStatus(context, "idle", "更新安装完成")
            }
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                    ?.takeIf { it.isNotBlank() }
                    ?: "系统未完成安装"
                UpdateManager.saveStatus(context, "error", message)
            }
        }
    }

    companion object {
        const val ACTION_INSTALL_STATUS = "com.nos.classcheck.UPDATE_INSTALL_STATUS"
    }
}

