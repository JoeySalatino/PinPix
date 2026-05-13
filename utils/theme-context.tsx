import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';

export type ThemeContextType = {
  isDark: boolean;
  toggleTheme: () => Promise<void>;
  setDarkMode: (dark: boolean) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const STORAGE_KEY = '@user_theme_preference';

export const ThemeProvider = ({ children }: { children: ReactNode }) => {
  const [isDark, setIsDark] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load theme from storage on mount
  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY);
        if (stored !== null) {
          setIsDark(stored === 'dark');
        }
      } catch (err) {
        console.error('Failed to load theme:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const setDarkMode = useCallback(async (dark: boolean) => {
    if (dark === isDark) return;
    setIsDark(dark);
    try {
      await AsyncStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light');
    } catch (err) {
      console.error('Failed to save theme:', err);
    }
  }, [isDark]);

  const toggleTheme = useCallback(async () => {
    await setDarkMode(!isDark);
  }, [isDark, setDarkMode]);

  // Optionally, render nothing until loaded
  if (loading) return null;

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme, setDarkMode }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextType => {
  const context = useContext(ThemeContext);
  if (!context) throw new Error('useTheme must be used within ThemeProvider');
  return context;
};