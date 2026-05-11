import 'dotenv/config';

export default {
  expo: {
    name: "PinPix",
    slug: "pinpix",
    owner: "joeysalatino",
    version: "1.0.0",
    scheme: "pinpix",
    orientation: "portrait",
    platforms: ["ios", "android"],
    icon: "./assets/images/icon.jpg",

    // ---- Splash screen config ----
    // expo-splash-screen will hold this visible until we manually hide it
    splash: {
      image: "./assets/images/icon.jpg",
      resizeMode: "contain",
      backgroundColor: "#112337",
    },

    ios: {
      bundleIdentifier: "com.yourname.pinpix",
      supportsTablet: true,
      infoPlist: {
        NSLocationWhenInUseUsageDescription: "We use your location to show nearby photo spots.",
        NSCameraUsageDescription: "We need camera access to let you add photos to spots.",
        NSPhotoLibraryUsageDescription: "We need photo library access to let you upload spot photos.",
      },
    },
    android: {
      package: "com.yourname.pinpix",
      adaptiveIcon: {
        foregroundImage: "./assets/images/icon.jpg",
        backgroundColor: "#112337",
      },
      config: {
        googleMaps: {
          apiKey: process.env.GOOGLE_MAPS_ANDROID_KEY || "",
        },
      },
    },
    plugins: [
      "expo-splash-screen",
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
      eas: {
        projectId: "21dbc58a-e5f1-41f1-aa7c-757c5497e902",
      },
    },
  },
};