import 'dotenv/config';

export default {
  expo: {
    name: "PinPix",
    slug: "pinpix",
    owner: "joeysalatino",
    version: "1.0.5",
    scheme: "pinpix",
    orientation: "portrait",
    platforms: ["ios", "android"],
    icon: "./assets/images/icon.jpg",

    // EAS Update — required when using `channel` in eas.json build profiles.
    // Builds pull JS updates from this URL using runtimeVersion to gate compat.
    updates: {
      url: "https://u.expo.dev/21dbc58a-e5f1-41f1-aa7c-757c5497e902",
    },
    runtimeVersion: {
      policy: "appVersion",
    },

    // ---- Splash screen config ----
    // expo-splash-screen will hold this visible until we manually hide it
    splash: {
      image: "./assets/images/icon.jpg",
      resizeMode: "contain",
      backgroundColor: "#112337",
    },

    ios: {
      bundleIdentifier: process.env.IOS_BUNDLE_ID || "com.pinpix.ios",
      supportsTablet: true,
      // Sign in with Apple requires this entitlement (added by the plugin below)
      usesAppleSignIn: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSLocationWhenInUseUsageDescription: "We use your location to show nearby photo spots.",
        NSCameraUsageDescription: "We need camera access to let you add photos to spots.",
        NSPhotoLibraryUsageDescription: "We use photo library access to upload your spot photo and read its location, if available.",
        // Google Sign-In requires registering the reversed iOS client ID as a URL scheme.
        // IMPORTANT: Do not set CFBundleURLTypes to *only* Google — that replaces Expo's
        // `scheme: "pinpix"` entry and breaks share / deep links ("cannot open" from Safari).
        CFBundleURLTypes: [
          {
            CFBundleURLName: 'com.pinpix.ios',
            CFBundleURLSchemes: ['pinpix'],
          },
          ...(process.env.GOOGLE_IOS_URL_SCHEME?.trim()
            ? [
                {
                  CFBundleURLSchemes: [process.env.GOOGLE_IOS_URL_SCHEME.trim()],
                },
              ]
            : []),
        ],
      },
    },
    android: {
      // Always use this package for Play Store — must match the app id
      // you registered in Google Play Console. Do not read ANDROID_PACKAGE
      // from EAS env here: a wrong remote value caused AAB rejections.
      package: "com.pinpix.android",
      adaptiveIcon: {
        foregroundImage: "./assets/images/icon.jpg",
        backgroundColor: "#112337",
      },
      permissions: [
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.CAMERA",
        "android.permission.POST_NOTIFICATIONS",
        "android.permission.READ_MEDIA_IMAGES",
      ],
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY || "",
        },
      },
      // After adding an Android app in Firebase (package com.pinpix.android),
      // download google-services.json to the project root for FCM push on device.
      ...(process.env.GOOGLE_SERVICES_FILE
        ? { googleServicesFile: process.env.GOOGLE_SERVICES_FILE }
        : {}),
    },
    plugins: [
      "expo-splash-screen",
      "expo-background-fetch",
      "expo-localization",
      [
        "expo-contacts",
        {
          contactsPermission:
            "PinPix reads contact emails and phone numbers on your device to find friends on the app. Your full contact list is not uploaded.",
        },
      ],
      [
        "expo-location",
        {
          locationWhenInUsePermission:
            "We use your location to show nearby photo spots.",
        },
      ],
      [
        "expo-image-picker",
        {
          photosPermission:
            "We use photo library access to upload your spot photo and read its location, if available.",
          cameraPermission: "We need camera access to let you add photos to spots.",
        },
      ],
      [
        "expo-notifications",
        {
          // Must match utils/push-notifications.ts ANDROID_PUSH_CHANNEL_ID
          defaultChannel: "default",
        },
      ],
      "@react-native-google-signin/google-signin",
      "expo-apple-authentication",
      [
        "@sentry/react-native/expo",
        {
          // Your Sentry DSN — get this from sentry.io after creating a project
          url: "https://sentry.io/",
          project: process.env.SENTRY_PROJECT || "",
          organization: process.env.SENTRY_ORG || "",
        },
      ],
    ],
    extra: {
      googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY || "",
      sentryDsn: process.env.SENTRY_DSN || "",
      sentry: {
        sendDefaultPii: process.env.SENTRY_SEND_DEFAULT_PII === "true",
        enableLogs: process.env.SENTRY_ENABLE_LOGS === "true",
        replaysSessionSampleRate: Number(process.env.SENTRY_REPLAYS_SESSION_SAMPLE_RATE ?? "0.1"),
        replaysOnErrorSampleRate: Number(process.env.SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE ?? "1"),
      },
      firebase: {
        apiKey: process.env.FIREBASE_API_KEY || "",
        authDomain: process.env.FIREBASE_AUTH_DOMAIN || "",
        projectId: process.env.FIREBASE_PROJECT_ID || "",
        storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
        messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
        appId: process.env.FIREBASE_APP_ID || "",
        measurementId: process.env.FIREBASE_MEASUREMENT_ID || "",
      },
      // OAuth client IDs for native Google Sign-In. The Web client ID is what
      // Firebase exchanges for an Auth credential, so it's required on both
      // platforms. The iOS client ID is only used on iOS.
      googleAuth: {
        webClientId: process.env.GOOGLE_WEB_CLIENT_ID || "",
        iosClientId: process.env.GOOGLE_IOS_CLIENT_ID || "",
      },
      eas: {
        projectId: "21dbc58a-e5f1-41f1-aa7c-757c5497e902",
      },
      // Optional HTTPS base for shared spot links (your own domain + /spot/{id} routes).
      // If unset, shares use the pinpix-legal GitHub Pages bridge (open-spot.html → app).
      shareWebBaseUrl: process.env.EXPO_PUBLIC_SHARE_WEB_BASE_URL?.trim() ?? "",
    },
  },
};