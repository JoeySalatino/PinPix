import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { registerBackgroundUpdatesFetch } from "../utils/background-updates-fetch";
import PushTokenRegistrar from "../components/PushTokenRegistrar";
import SpotDeepLinkBootstrap from "../components/SpotDeepLinkBootstrap";
import { ThemeProvider, useTheme } from "../utils/theme-context";
import * as Sentry from '@sentry/react-native';
import { initSentry } from "../utils/sentry";
import { registerBackgroundUpdatesFetch } from "../utils/background-updates-fetch";

initSentry();

function ThemedRootStack() {
  const { isDark } = useTheme();
  return (
    <>
      <StatusBar style={isDark ? "light" : "dark"} />
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      />
    </>
  );
}

export default Sentry.wrap(function RootLayout() {
  useEffect(() => {
    void registerBackgroundUpdatesFetch();
  }, []);

  return (
    <ThemeProvider>
      <SpotDeepLinkBootstrap />
      <PushNotificationDeepLink />
      <PushTokenRegistrar />
      <ThemedRootStack />
    </ThemeProvider>
  );
});