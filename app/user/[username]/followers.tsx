import { useLocalSearchParams } from 'expo-router';
import UserFollowListScreen from '../../../components/UserFollowListScreen';

export default function UserFollowersScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  return (
    <UserFollowListScreen
      usernameSlug={(username || '').toLowerCase()}
      listKind="followers"
    />
  );
}
