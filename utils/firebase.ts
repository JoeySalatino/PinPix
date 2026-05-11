import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import Constants from 'expo-constants';

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

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);