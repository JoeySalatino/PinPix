import { ActionSheetIOS, Alert, Platform } from 'react-native';

export function showSpotCommentActionMenu(opts: {
  isAuthor: boolean;
  isSpotOwner: boolean;
  hasThreadReplies: boolean;
  onEdit?: () => void;
  onDelete: () => void;
}): void {
  const { isAuthor, isSpotOwner, hasThreadReplies, onEdit, onDelete } = opts;
  if (!isAuthor && !isSpotOwner) return;

  const deleteTitle = hasThreadReplies ? 'Delete thread?' : 'Delete comment?';
  const deleteMessage = hasThreadReplies
    ? 'This will remove this comment and all replies. This cannot be undone.'
    : 'This cannot be undone.';

  if (isAuthor && onEdit) {
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ['Edit', 'Delete', 'Cancel'],
          cancelButtonIndex: 2,
          destructiveButtonIndex: 1,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) onEdit();
          else if (buttonIndex === 1) {
            Alert.alert(deleteTitle, deleteMessage, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: onDelete },
            ]);
          }
        }
      );
    } else {
      Alert.alert('Comment', undefined, [
        { text: 'Edit', onPress: onEdit },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            Alert.alert(deleteTitle, deleteMessage, [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Delete', style: 'destructive', onPress: onDelete },
            ]),
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
    return;
  }

  if (Platform.OS === 'ios') {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: deleteTitle,
        message: deleteMessage,
        options: ['Delete', 'Cancel'],
        cancelButtonIndex: 1,
        destructiveButtonIndex: 0,
      },
      (buttonIndex) => {
        if (buttonIndex === 0) onDelete();
      }
    );
  } else {
    Alert.alert(deleteTitle, deleteMessage, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: onDelete },
    ]);
  }
}
