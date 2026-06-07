import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import {
  Platform,
  StyleSheet,
  TextInput,
  TextInputProps,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { BRAND } from '../constants/brand';

const { cream: CREAM, creamDark: CREAM_DARK } = BRAND;

type PasswordInputProps = Omit<TextInputProps, 'secureTextEntry'> & {
  containerStyle?: StyleProp<ViewStyle>;
};

export default function PasswordInput({ style, containerStyle, ...rest }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <View style={[styles.container, containerStyle]} pointerEvents="box-none">
      <TextInput
        {...rest}
        style={[styles.input, style, styles.inputWithToggle]}
        secureTextEntry={!visible}
        autoCapitalize="none"
        autoCorrect={false}
        textContentType={visible ? 'none' : 'password'}
        autoComplete={visible ? 'off' : 'password'}
      />
      <TouchableOpacity
        style={styles.toggle}
        onPress={() => setVisible((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={visible ? 'Hide password' : 'Show password'}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        activeOpacity={0.7}
      >
        <Ionicons
          name={visible ? 'eye-off-outline' : 'eye-outline'}
          size={22}
          color={CREAM_DARK}
        />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    marginBottom: 16,
  },
  input: {
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: CREAM,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.15)',
  },
  inputWithToggle: {
    paddingRight: 48,
  },
  toggle: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 48,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 2,
    ...Platform.select({
      android: { elevation: 2 },
    }),
  },
});
