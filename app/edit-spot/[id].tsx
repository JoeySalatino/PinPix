// ============================================================
// edit-spot/[id] — Redirect to add-spot in edit mode
// ------------------------------------------------------------
// Keeps a readable URL while reusing the full add/edit form.
// ============================================================

import { Redirect, useLocalSearchParams } from 'expo-router';

export default function EditSpotRedirect() {
  const { id } = useLocalSearchParams<{ id: string | string[] }>();
  const spotId = Array.isArray(id) ? id[0] : id;
  if (!spotId) return null;
  return <Redirect href={{ pathname: '/add-spot', params: { edit: spotId } }} />;
}
