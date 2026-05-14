import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import * as Updates from 'expo-updates';

/** iOS `fetch` background mode — used to prefetch EAS Update bundles when the OS allows. */
export const BACKGROUND_UPDATE_TASK = 'pinpix-eas-update-background-fetch';

TaskManager.defineTask(BACKGROUND_UPDATE_TASK, async () => {
  try {
    if (__DEV__ || !Updates.isEnabled) {
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }
    const check = await Updates.checkForUpdateAsync();
    if (check.isAvailable) {
      await Updates.fetchUpdateAsync();
      return BackgroundFetch.BackgroundFetchResult.NewData;
    }
    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

/** Registers OS-driven background fetch (shows under Background App Refresh when enabled). */
export async function registerBackgroundUpdatesFetch(): Promise<void> {
  if (__DEV__) return;

  const status = await BackgroundFetch.getStatusAsync();
  if (status !== BackgroundFetch.BackgroundFetchStatus.Available) return;

  const registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_UPDATE_TASK);
  if (registered) return;

  await BackgroundFetch.registerTaskAsync(BACKGROUND_UPDATE_TASK, {
    minimumInterval: 12 * 60 * 60,
    stopOnTerminate: false,
    startOnBoot: true,
  });
}
