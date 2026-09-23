import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val keystorePropertiesFile = rootProject.file("app/keystore.properties")
val keystoreProperties = Properties()
if (keystorePropertiesFile.exists()) {
    keystorePropertiesFile.inputStream().use { keystoreProperties.load(it) }
}

fun signingValue(name: String): String? =
    (keystoreProperties[name] as String?) ?: System.getenv(name.uppercase().replace(".", "_"))

android {
    namespace = "com.nos.classcheck"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.nos.classcheck"
        minSdk = 29
        targetSdk = 35
        versionCode = 11
        versionName = "1.2.4"
    }

    signingConfigs {
        create("releaseLocal") {
            val storeFilePath = signingValue("storeFile")
            if (!storeFilePath.isNullOrBlank()) {
                storeFile = file(storeFilePath)
                storePassword = signingValue("storePassword")
                keyAlias = signingValue("keyAlias")
                keyPassword = signingValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (signingConfigs.getByName("releaseLocal").storeFile != null) {
                signingConfig = signingConfigs.getByName("releaseLocal")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
