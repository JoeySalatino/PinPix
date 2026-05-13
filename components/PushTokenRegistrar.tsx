// ============================================================
// Registers Expo push token when a user is signed in and has
// pushEnabled on their profile (default: on).
// ============================================================

import { onAuthStateChanged } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { useEffect, useRef } from 'react';
import { auth, db } from '../utils/firebase';
import { registerAndUploadPushToken } from '../utils/push-notifications';
import { captureError } from '../utils/sentry';

export default function PushTokenRegistrar() {
  const uidRef = useRef<string | null>(null);

  useEffect(() => {
    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        uidRef.current = null;
        return;
      }
      uidRef.current = user.uid;
      try {
        const snap = await getDoc(doc(db, 'users', user.uid));
        const pushEnabled = snap.exists() ? snap.data()?.pushEnabled !== false : true;
        if (!pushEnabled) return;
        await registerAndUploadPushToken(user.uid);
      } catch (e) {
        captureError(e, { area: 'PushTokenRegistrar', uid: user.uid });
      }
    });
  }, []);

  return null;
}
