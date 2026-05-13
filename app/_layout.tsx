import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import PushNotificationDeepLink from "../components/PushNotificationDeepLink";
import PushTokenRegistrar from "../components/PushTokenRegistrar";
import SpotDeepLinkBootstrap from "../components/SpotDeepLinkBootstrap";
import { ThemeProvider, useTheme } from "../utils/theme-context";
import * as Sentry from '@sentry/react-native';
import { initSentry } from "../utils/sentry";

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
  return (
    <ThemeProvider>
      <SpotDeepLinkBootstrap />
      <PushNotificationDeepLink />
      <PushTokenRegistrar />
      <ThemedRootStack />
    </ThemeProvider>
  );
});