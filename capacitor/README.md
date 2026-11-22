# EdgeChat Capacitor Android

The EdgeChat Android app bundles the Web UI and uses the application ID `com.aozorae.edgechat.web`.

The Vue UI remains the source of product behavior. A small Kotlin plugin provides Android file selection, local notifications, notification room opening, and external URL handling. The APK contains no fixed EdgeChat deployment: users enter their HTTPS server URL on the first sign-in screen.

## Build

Install JDK 21 and Android SDK 36 first.

```bash
npm ci
npm run build:capacitor
```

The Debug APK is written to `capacitor/android/app/build/outputs/apk/debug/app-debug.apk`.

## Release

Push an `android-v*` tag or run the GitHub `Android Release` workflow. It restores the signing keystore from the four `ANDROID_KEYSTORE_*` Repository Secrets, then publishes a signed APK, AAB, and `SHA256SUMS.txt`.
