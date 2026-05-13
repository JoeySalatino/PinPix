import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import PushNotificationDeepLink from "../components/PushNotificationDeepLink";
import PushTokenRegistrar from "../components/PushTokenRegistrar";
import { ThemeProvider } from "../utils/theme-context";
import * as Sentry from '@sentry/react-native';
import { initSentry } from "../utils/sentry";

initSentry();

export default Sentry.wrap(function RootLayout() {
  return (
    <ThemeProvider>
      <PushNotificationDeepLink />
      <PushTokenRegistrar />
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      />
    </ThemeProvider>
  );
});