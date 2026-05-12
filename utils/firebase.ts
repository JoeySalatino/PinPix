import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { initializeApp } from 'firebase/app';
import { Auth, getAuth, initializeAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

type FirebaseExtraConfig = {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
};

const firebaseConfig = (Constants.expoConfig?.extra?.firebase ?? {}) as Partial<FirebaseExtraConfig>;

const requiredKeys: (keyof FirebaseExtraConfig)[] = [
  'apiKey',
  'authDomain',
  'projectId',
  'storageBucket',
  'messagingSenderId',
  'appId',
];

const missing = requiredKeys.filter((k) => !firebaseConfig[k]);
if (missing.length > 0) {
  // Throw early in dev so it's immediately obvious what is misconfigured.
  // In production builds these values should always be set via app.config.ts.
  throw new Error(`[Firebase] Missing config keys: ${missing.join(', ')}`);
}

const app = initializeApp(firebaseConfig as FirebaseExtraConfig);

// Initialize auth with AsyncStorage persistence so users stay signed in across
// app launches (the default for Firebase JS SDK in React Native is in-memory,
// which logs users out as soon as the app is killed).
//
// `getReactNativePersistence` is exported from 'firebase/auth' but its TypeScript
// types are not always declared, so we resolve it lazily through `require` to
// keep this compiling under all firebase versions we ship with.
function createAuth(): Auth {
  try {
    const firebaseAuth = require('firebase/auth');
    const persistence = firebaseAuth.getReactNativePersistence?.(AsyncStorage);
    if (persistence) {
      return initializeAuth(app, { persistence });
    }
  } catch {
    // Fall through to getAuth below — fast refresh / second init paths.
  }
  return getAuth(app);
}

export const auth = createAuth();
export const db = getFirestore(app);
export const storage = getStorage(app);