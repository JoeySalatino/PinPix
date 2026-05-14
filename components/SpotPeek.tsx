// ============================================================
// SpotPeek.tsx — Bottom Sheet Spot Preview
// ------------------------------------------------------------
// Slide-up card shown when a map pin (or grid tile) is tapped.
// Displays:
//   - Image carousel (one slide per spot at this pin)
//   - Title, posted-by username (tappable to public profile)
//   - Address with Apple/Google Maps directions link
//   - Caption, tags (tappable to filter)
//   - Comments (modal): Instagram-style rows — avatar, username + body, time · Reply,
//     heart on the right; long-press to delete when you are the author or spot owner.
//   - Heart + like count (bottom-left); circular comments next to it; bookmark, share, directions (bottom-right) on photo scrim
//   - Tap-to-zoom fullscreen photo viewer
//   - Close, edit/delete or block/flag (overlaid on top of photo with scrim)
//
// Future: rewrite using @gorhom/bottom-sheet so the sheet is
// actually draggable. Today it's fixed-height for simplicity.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { collection, doc, getDoc, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import ImageView from 'react-native-image-viewing';
import { BRAND } from '../constants/brand';
import { auth, db } from '../utils/firebase';
import { captureError } from '../utils/sentry';
import {
  addSpotComment,
  deleteSpotComment,
  deleteSpotCommentThread,
  formatSpotCommentTime,
  SPOT_COMMENT_MAX_LEN,
  toggleCommentLike,
  type SpotCommentRow,
} from '../utils/spot-comments';
import { shareSpot } from '../utils/share';
import { followingUidList, toggleBookmark, toggleSpotLike } from '../utils/social';
import { Spot, spotGalleryUrls } from './types';

const { width, height: WIN_H } = Dimensions.get('window');
const { navy: NAVY, orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, danger: DANGER } = BRAND;

type SpotPeekProps = {
  spots: Spot[];
  onClose: () => void;
  openDirections: (spot: Spot) => void;
  isDark: boolean;
  currentUserId: string;
  onDelete: (spot: Spot) => void;
  /** Owner: full edit form (photos, title, location, tags). */
  onEdit?: (spot: Spot) => void;
  onReport: (spot: Spot) => void;
  /** When set, non-owners see a Block control (UGC safety / App Store). */
  onBlock?: (spot: Spot) => void;
  // Optional: if provided, tapping a tag bubbles up so the parent can filter.
  onTagPress?: (tag: string) => void;
  // Optional: hide the @username link (e.g. when already on that user's profile)
  showUsernameLink?: boolean;
  /** From push / deep link: open comments and scroll to this comment id. */
  initialFocusCommentId?: string | null;
  onInitialFocusCommentHandled?: () => void;
};

export default function SpotPeek({
  spots,
  onClose,
  openDirections,
  isDark,
  currentUserId,
  onDelete,
  onEdit,
  onReport,
  onBlock,
  onTagPress,
  showUsernameLink = true,
  initialFocusCommentId = null,
  onInitialFocusCommentHandled,
}: SpotPeekProps) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [zoomVisible, setZoomVisible] = useState(false);
  const [zoomImageIndex, setZoomImageIndex] = useState(0);
  const [innerPhotoIndex, setInnerPhotoIndex] = useState(0);
  const [likeCount, setLikeCount] = useState(0);
  const [likedByMe, setLikedByMe] = useState(false);
  const [isBookmarked, setIsBookmarked] = useState(false);
  /** false/null: hide "Posted by @…" (private author + viewer not following). */
  const [showPostedByAttribution, setShowPostedByAttribution] = useState<boolean | null>(null);

  // Pre-compute the list of images for the fullscreen zoom viewer
  // (only includes spots that actually have an image). Hooks must run
  // before any early return — see react-hooks/rules-of-hooks.
  const zoomImages = useMemo(
    () =>
      (spots || []).flatMap((s) => spotGalleryUrls(s).map((uri) => ({ uri }))),
    [spots]
  );

  const spotIdsKey = useMemo(() => (spots || []).map((s) => s.id).join('|'), [spots]);
  const postedByAuthorUid = useMemo(() => {
    if (!spots?.length) return null;
    const i = Math.min(Math.max(0, index), spots.length - 1);
    const uid = spots[i]?.userId;
    return uid && String(uid).trim() ? String(uid) : null;
  }, [spots, index, spotIdsKey]);
  const spotCount = spots?.length ?? 0;
  const carouselRef = useRef<FlatList<Spot>>(null);

  useEffect(() => {
    setInnerPhotoIndex(0);
  }, [index, spotIdsKey]);

  // When the spot list at this pin changes (filters, etc.), reset carousel
  // scroll and index so we never read spots[index] out of range.
  useEffect(() => {
    if (!spots || spots.length === 0) return;
    setIndex(0);
    const id = requestAnimationFrame(() => {
      carouselRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
    return () => cancelAnimationFrame(id);
    // spotIdsKey encodes which spots are in the carousel; we must not reset on
    // unrelated `spots` reference changes from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps: spotIdsKey only
  }, [spotIdsKey]);

  // Keep index in range when length shrinks or FlatList reports an out-of-range page.
  useEffect(() => {
    if (spotCount === 0) return;
    const clamped = Math.min(Math.max(0, index), spotCount - 1);
    if (clamped !== index) setIndex(clamped);
  }, [index, spotCount]);

  // Corrupt / incomplete spot data — close rather than rendering a broken sheet.
  useEffect(() => {
    if (spotCount === 0 || !spots) return;
    const i = Math.min(Math.max(0, index), spotCount - 1);
    const s = spots[i];
    if (!s || typeof s.latitude !== 'number' || typeof s.longitude !== 'number') {
      onClose();
    }
  }, [spots, spotCount, index, onClose]);

  // Like count + bookmark presence for the visible spot.
  useEffect(() => {
    if (!spots?.length) return;
    const i = Math.min(Math.max(0, index), spots.length - 1);
    const s = spots[i];
    if (!s?.id) return;
    const me = auth.currentUser?.uid;
    const unsubLikes = onSnapshot(collection(db, 'spots', s.id, 'likes'), (snap) => {
      setLikeCount(snap.size);
      setLikedByMe(me ? snap.docs.some((d) => d.id === me) : false);
    });
    let unsubBm: (() => void) | undefined;
    if (me) {
      unsubBm = onSnapshot(doc(db, 'users', me, 'bookmarks', s.id), (bm) => {
        setIsBookmarked(bm.exists());
      });
    } else {
      setIsBookmarked(false);
    }
    return () => {
      unsubLikes();
      unsubBm?.();
    };
    // spotIdsKey + index define visible spot; avoid depending on `spots` identity each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, spotIdsKey]);

  // Hide "Posted by @username" when the author is private and the viewer does not follow them yet.
  useEffect(() => {
    if (!spots?.length) {
      setShowPostedByAttribution(true);
      return;
    }
    const authorId = postedByAuthorUid;
    if (!authorId) {
      setShowPostedByAttribution(true);
      return;
    }
    if (currentUserId && authorId === currentUserId) {
      setShowPostedByAttribution(true);
      return;
    }

    setShowPostedByAttribution(null);
    let cancelled = false;
    void (async () => {
      try {
        const authorSnap = await getDoc(doc(db, 'users', authorId));
        if (cancelled) return;
        const authorPrivate =
          authorSnap.exists() && (authorSnap.data()?.profileVisible as boolean | undefined) === false;
        if (!authorPrivate) {
          setShowPostedByAttribution(true);
          return;
        }
        if (!currentUserId) {
          setShowPostedByAttribution(false);
          return;
        }
        const viewerSnap = await getDoc(doc(db, 'users', currentUserId));
        if (cancelled) return;
        const following = followingUidList(viewerSnap.data() as Record<string, unknown>);
        setShowPostedByAttribution(following.includes(authorId));
      } catch (e) {
        captureError(e, { area: 'SpotPeek.postedByPrivacy', authorId });
        if (!cancelled) setShowPostedByAttribution(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [postedByAuthorUid, currentUserId]);

  const commentSpotId = useMemo(() => {
    if (!spots?.length) return '';
    const i = Math.min(Math.max(0, index), spots.length - 1);
    return spots[i]?.id || '';
  }, [spots, index]);

  const commentSpotOwnerUid = useMemo(() => {
    if (!spots?.length) return '';
    const i = Math.min(Math.max(0, index), spots.length - 1);
    return spots[i]?.userId || '';
  }, [spots, index]);

  const [spotComments, setSpotComments] = useState<SpotCommentRow[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentSending, setCommentSending] = useState(false);
  const [viewerCommentUsername, setViewerCommentUsername] = useState('');
  const [replyParentId, setReplyParentId] = useState<string | null>(null);
  const [replyParentUsername, setReplyParentUsername] = useState<string | null>(null);
  const [commentLikeMap, setCommentLikeMap] = useState<Record<string, { count: number; liked: boolean }>>(
    {}
  );
  const [commentsModalOpen, setCommentsModalOpen] = useState(false);
  const [pulseCommentId, setPulseCommentId] = useState<string | null>(null);
  const commentsListRef = useRef<FlatList<{
    c: SpotCommentRow;
    isReply: boolean;
    showReply: boolean;
    threadEnd: boolean;
  }>>(null);
  const focusHandledRef = useRef(false);

  useEffect(() => {
    setCommentDraft('');
    setReplyParentId(null);
    setReplyParentUsername(null);
    setCommentsModalOpen(false);
    setPulseCommentId(null);
    focusHandledRef.current = false;
  }, [commentSpotId]);

  useEffect(() => {
    if (!currentUserId) {
      setViewerCommentUsername('');
      return;
    }
    let cancelled = false;
    void getDoc(doc(db, 'users', currentUserId)).then((snap) => {
      if (cancelled) return;
      const u = (snap.data()?.username as string | undefined)?.trim().toLowerCase() ?? '';
      setViewerCommentUsername(u);
    });
    return () => {
      cancelled = true;
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!commentSpotId) {
      setSpotComments([]);
      return;
    }
    const q = query(
      collection(db, 'spots', commentSpotId, 'comments'),
      orderBy('createdAt', 'asc'),
      limit(100)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        setSpotComments(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              userId: String(data.userId ?? ''),
              username: String(data.username ?? ''),
              text: String(data.text ?? ''),
              parentCommentId:
                typeof data.parentCommentId === 'string' && data.parentCommentId.trim()
                  ? data.parentCommentId.trim()
                  : undefined,
              createdAt: data.createdAt,
            };
          })
        );
      },
      (e) => {
        captureError(e, { area: 'SpotPeek.commentsQuery', spotId: commentSpotId });
      }
    );
    return () => unsub();
  }, [commentSpotId]);

  const commentIdsKey = useMemo(
    () => spotComments.map((c) => c.id).sort().join('|'),
    [spotComments]
  );

  const commentThreads = useMemo(() => {
    if (!spotComments.length) return [] as { root: SpotCommentRow; replies: SpotCommentRow[] }[];
    const byParent = new Map<string, SpotCommentRow[]>();
    const roots: SpotCommentRow[] = [];
    for (const r of spotComments) {
      const p = r.parentCommentId?.trim();
      if (!p) roots.push(r);
      else {
        const arr = byParent.get(p) ?? [];
        arr.push(r);
        byParent.set(p, arr);
      }
    }
    const sortByTime = (a: SpotCommentRow, b: SpotCommentRow) =>
      (a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0);
    roots.sort(sortByTime);
    return roots.map((root) => ({
      root,
      replies: (byParent.get(root.id) ?? []).slice().sort(sortByTime),
    }));
  }, [spotComments]);

  const flatCommentRows = useMemo(() => {
    const rows: {
      c: SpotCommentRow;
      isReply: boolean;
      showReply: boolean;
      threadEnd: boolean;
    }[] = [];
    for (const { root, replies } of commentThreads) {
      const rs = replies;
      if (rs.length === 0) {
        rows.push({ c: root, isReply: false, showReply: true, threadEnd: true });
      } else {
        rows.push({ c: root, isReply: false, showReply: true, threadEnd: false });
        for (let i = 0; i < rs.length; i++) {
          rows.push({
            c: rs[i],
            isReply: true,
            showReply: false,
            threadEnd: i === rs.length - 1,
          });
        }
      }
    }
    return rows;
  }, [commentThreads]);

  const commentTotalCount = spotComments.length;

  const [commentAvatars, setCommentAvatars] = useState<Record<string, string | null>>({});
  const commentAvatarFetchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setCommentAvatars({});
    commentAvatarFetchedRef.current = new Set();
  }, [commentSpotId]);

  useEffect(() => {
    const uids = [...new Set(spotComments.map((c) => c.userId).filter(Boolean))];
    const toFetch = uids.filter((uid) => !commentAvatarFetchedRef.current.has(uid));
    if (toFetch.length === 0) return;
    let cancelled = false;
    void (async () => {
      try {
        const entries = await Promise.all(
          toFetch.map(async (uid) => {
            try {
              const s = await getDoc(doc(db, 'users', uid));
              if (!s.exists()) return [uid, null] as const;
              const raw = (s.data() as { profileImage?: unknown }).profileImage;
              const url = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
              return [uid, url, true] as const;
            } catch {
              return [uid, null, false] as const;
            }
          })
        );
        if (cancelled) return;
        for (const row of entries) {
          const [uid, , ok] = row;
          if (ok) commentAvatarFetchedRef.current.add(uid);
        }
        setCommentAvatars((prev) => {
          const next = { ...prev };
          for (const [uid, url, ok] of entries) {
            if (ok) next[uid] = url;
          }
          return next;
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spotComments]);

  useEffect(() => {
    if (!commentSpotId || !commentIdsKey) {
      setCommentLikeMap({});
      return;
    }
    const ids = commentIdsKey.split('|').filter(Boolean);
    if (ids.length === 0) {
      setCommentLikeMap({});
      return;
    }
    const me = currentUserId || '';
    const unsubs = ids.map((id) =>
      onSnapshot(
        collection(db, 'spots', commentSpotId, 'comments', id, 'likes'),
        (snap) => {
          setCommentLikeMap((prev) => ({
            ...prev,
            [id]: {
              count: snap.size,
              liked: !!me && snap.docs.some((d) => d.id === me),
            },
          }));
        },
        (e) => {
          captureError(e, { area: 'SpotPeek.commentLikes', commentId: id });
        }
      )
    );
    return () => {
      unsubs.forEach((u) => u());
    };
  }, [commentSpotId, commentIdsKey, currentUserId]);

  const performDeleteComment = (c: SpotCommentRow) => {
    if (!commentSpotId) return;
    const op = c.parentCommentId
      ? deleteSpotComment(commentSpotId, c.id)
      : deleteSpotCommentThread(commentSpotId, c.id);
    void op.catch((err) => {
      captureError(err, { area: 'SpotPeek.deleteComment', commentId: c.id });
      Alert.alert('Could not delete', 'Please try again.');
    });
  };

  const openCommentLongPressMenu = (c: SpotCommentRow) => {
    if (!commentSpotId || !currentUserId) return;
    const isAuthor = c.userId === currentUserId;
    const isSpotOwner = commentSpotOwnerUid === currentUserId;
    if (!isAuthor && !isSpotOwner) return;
    const hasReplies =
      !c.parentCommentId &&
      commentThreads.some((t) => t.root.id === c.id && t.replies.length > 0);
    const message = hasReplies
      ? 'This will remove this comment and all replies. This cannot be undone.'
      : 'This cannot be undone.';
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: hasReplies ? 'Delete thread?' : 'Delete comment?',
          message,
          options: ['Delete', 'Cancel'],
          cancelButtonIndex: 1,
          destructiveButtonIndex: 0,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) performDeleteComment(c);
        }
      );
    } else {
      Alert.alert(hasReplies ? 'Delete thread?' : 'Delete comment?', message, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => performDeleteComment(c) },
      ]);
    }
  };

  useEffect(() => {
    focusHandledRef.current = false;
  }, [initialFocusCommentId]);

  useEffect(() => {
    if (!initialFocusCommentId) return;
    setCommentsModalOpen(true);
  }, [initialFocusCommentId]);

  const finalizeCommentFocus = useCallback(() => {
    if (!initialFocusCommentId || focusHandledRef.current) return;
    focusHandledRef.current = true;
    onInitialFocusCommentHandled?.();
  }, [initialFocusCommentId, onInitialFocusCommentHandled]);

  const closeCommentsModal = useCallback(() => {
    setCommentsModalOpen(false);
    Keyboard.dismiss();
    finalizeCommentFocus();
  }, [finalizeCommentFocus]);

  useEffect(() => {
    if (!initialFocusCommentId || !commentsModalOpen) return;
    const idx = flatCommentRows.findIndex((r) => r.c.id === initialFocusCommentId);
    if (idx < 0) return;

    setPulseCommentId(initialFocusCommentId);
    const pulseClear = setTimeout(() => setPulseCommentId(null), 2600);

    const scrollTry = () => {
      try {
        commentsListRef.current?.scrollToIndex({
          index: idx,
          viewPosition: 0.35,
          animated: true,
        });
      } catch {
        /* layout */
      }
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(scrollTry);
    });

    const consumeT = setTimeout(() => finalizeCommentFocus(), 2200);
    return () => {
      clearTimeout(pulseClear);
      clearTimeout(consumeT);
    };
  }, [initialFocusCommentId, commentsModalOpen, flatCommentRows, finalizeCommentFocus]);

  useEffect(() => {
    if (!initialFocusCommentId || !commentsModalOpen) return;
    const t = setTimeout(() => {
      if (focusHandledRef.current) return;
      const idx = flatCommentRows.findIndex((r) => r.c.id === initialFocusCommentId);
      if (idx >= 0) return;
      finalizeCommentFocus();
    }, 2000);
    return () => clearTimeout(t);
  }, [initialFocusCommentId, commentsModalOpen, flatCommentRows, finalizeCommentFocus]);

  if (!spots || spots.length === 0) return null;

  const maxIdx = spots.length - 1;
  const safeIndex = Math.min(Math.max(0, index), maxIdx);
  const spot = spots[safeIndex];
  if (!spot || typeof spot.latitude !== 'number' || typeof spot.longitude !== 'number') {
    return null;
  }
  const isOwner = currentUserId === spot.userId;
  const sheetBg = isDark ? '#0d1c2b' : NAVY;
  const peekGalleryUrls = spotGalleryUrls(spot);
  const peekMultiPhoto = peekGalleryUrls.length > 1;

  const handleUsernamePress = () => {
    if (!spot.username) return;
    onClose();
    // Use the lowercase form in the URL since /user/[username] queries
    // Firestore's lowercase `username` field.
    router.push(`/user/${spot.username.toLowerCase()}`);
  };

  const handleToggleLike = async () => {
    if (!currentUserId || !spot.id) return;
    try {
      await toggleSpotLike(spot.id, likedByMe);
    } catch (e) {
      captureError(e, { area: 'SpotPeek.toggleLike', spotId: spot.id });
    }
  };

  const handleToggleBookmark = async () => {
    if (!currentUserId) return;
    try {
      const thumb = spotGalleryUrls(spot)[0] || spot.imageUrl || '';
      await toggleBookmark(
        {
          id: spot.id,
          title: spot.title,
          imageUrl: thumb,
          latitude: spot.latitude,
          longitude: spot.longitude,
          address: spot.address,
        },
        isBookmarked
      );
    } catch (e) {
      captureError(e, { area: 'SpotPeek.toggleBookmark', spotId: spot.id });
    }
  };

  const openCommenterFromComment = (uname: string) => {
    const slug = uname.trim().toLowerCase();
    if (!slug) return;
    onClose();
    router.push(`/user/${slug}`);
  };

  const handleSendComment = async () => {
    if (!currentUserId || !commentSpotId || !viewerCommentUsername) return;
    const trimmed = commentDraft.trim();
    if (!trimmed || commentSending) return;
    setCommentSending(true);
    try {
      await addSpotComment(
        commentSpotId,
        trimmed,
        currentUserId,
        viewerCommentUsername,
        replyParentId
      );
      setCommentDraft('');
      setReplyParentId(null);
      setReplyParentUsername(null);
      Keyboard.dismiss();
    } catch (e) {
      captureError(e, { area: 'SpotPeek.addComment', spotId: commentSpotId });
      Alert.alert('Could not post', 'Check your connection and try again.');
    } finally {
      setCommentSending(false);
    }
  };

  const handleToggleCommentLike = async (commentId: string, liked: boolean) => {
    if (!currentUserId || !commentSpotId) return;
    try {
      await toggleCommentLike(commentSpotId, commentId, liked);
    } catch (e) {
      captureError(e, { area: 'SpotPeek.toggleCommentLike', commentId });
    }
  };

  const renderCommentRow = (
    c: SpotCommentRow,
    { isReply, showReply }: { isReply: boolean; showReply: boolean },
    highlight = false,
    threadEnd = false
  ) => {
    const canDelete =
      !!currentUserId && (c.userId === currentUserId || commentSpotOwnerUid === currentUserId);
    const lk = commentLikeMap[c.id] ?? { count: 0, liked: false };
    const avatarUri = c.userId ? commentAvatars[c.userId] : undefined;
    const uname = (c.username || 'user').trim();

    return (
      <View
        style={[
          styles.igCommentRow,
          isReply && styles.igCommentRowReply,
          highlight && styles.igCommentRowHighlight,
          threadEnd && styles.igCommentRowThreadEnd,
        ]}
      >
        <Pressable
          style={styles.igCommentPressable}
          onLongPress={canDelete ? () => openCommentLongPressMenu(c) : undefined}
          delayLongPress={450}
          accessibilityHint={canDelete ? 'Hold to show delete options' : undefined}
        >
          <TouchableOpacity
            onPress={() => openCommenterFromComment(c.username)}
            activeOpacity={0.85}
            accessibilityLabel={`Open profile @${uname}`}
          >
            {avatarUri ? (
              <ExpoImage source={{ uri: avatarUri }} style={styles.igAvatar} contentFit="cover" />
            ) : (
              <View style={[styles.igAvatar, styles.igAvatarPlaceholder]}>
                <Ionicons name="person" size={16} color={CREAM_DARK} />
              </View>
            )}
          </TouchableOpacity>
          <View style={styles.igCommentTextCol}>
            <Text style={styles.igCommentMainLine}>
              <Text
                style={styles.igCommentUsername}
                onPress={() => openCommenterFromComment(c.username)}
                suppressHighlighting={!c.username}
              >
                {uname}{' '}
              </Text>
              <Text style={[styles.igCommentBody, isReply && styles.igCommentBodyReply]}>{c.text}</Text>
            </Text>
            <View style={styles.igCommentMetaRow}>
              <Text style={styles.igCommentTime}>{formatSpotCommentTime(c.createdAt)}</Text>
              {showReply && !!currentUserId && !!viewerCommentUsername ? (
                <>
                  <Text style={styles.igCommentMetaDot}> · </Text>
                  <Pressable
                    onPress={() => {
                      setReplyParentId(c.id);
                      setReplyParentUsername(c.username || null);
                    }}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Reply to comment"
                  >
                    <Text style={styles.igReplyLink}>Reply</Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </View>
        </Pressable>
        {!!currentUserId ? (
          <TouchableOpacity
            style={styles.igHeartColumn}
            onPress={() => void handleToggleCommentLike(c.id, lk.liked)}
            hitSlop={{ top: 10, bottom: 10, left: 8, right: 4 }}
            accessibilityLabel={lk.liked ? 'Unlike comment' : 'Like comment'}
          >
            <Ionicons
              name={lk.liked ? 'heart' : 'heart-outline'}
              size={22}
              color={lk.liked ? DANGER : CREAM}
            />
            {lk.count > 0 ? <Text style={styles.igHeartCount}>{lk.count}</Text> : null}
          </TouchableOpacity>
        ) : (
          <View style={styles.igHeartColumn} pointerEvents="none" accessibilityElementsHidden>
            <Ionicons name="heart-outline" size={22} color={CREAM_DARK} />
            {lk.count > 0 ? <Text style={styles.igHeartCountMuted}>{lk.count}</Text> : null}
          </View>
        )}
      </View>
    );
  };

  const openZoomForSpotItem = (item: Spot, urls: string[]) => {
    Keyboard.dismiss();
    if (zoomImages.length === 0) return;
    const si = spots.findIndex((s) => s.id === item.id);
    if (si < 0) return;
    let acc = 0;
    for (let i = 0; i < si; i++) {
      acc += spotGalleryUrls(spots[i]).length;
    }
    const inner =
      si === safeIndex
        ? Math.min(innerPhotoIndex, Math.max(0, urls.length - 1))
        : 0;
    const zi = Math.min(acc + inner, Math.max(0, zoomImages.length - 1));
    setZoomImageIndex(zi);
    setZoomVisible(true);
  };

  return (
    <View style={[styles.sheet, { backgroundColor: sheetBg }]}>
      {/* ---- Horizontal image carousel ---- */}
      <View style={styles.imageContainer}>
        <FlatList
          ref={carouselRef}
          data={spots}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={(item) => item.id}
          onMomentumScrollEnd={(e) => {
            const max = spots.length - 1;
            if (max < 0) return;
            const raw = Math.round(e.nativeEvent.contentOffset.x / width);
            setIndex(Math.min(Math.max(0, raw), max));
          }}
          renderItem={({ item }) => {
            const urls = spotGalleryUrls(item);
            const itemHasImage = urls.length > 0;

            if (!itemHasImage) {
              return (
                <View style={styles.imageSlide}>
                  <View style={styles.imagePlaceholder}>
                    <Ionicons name="image-outline" size={40} color={CREAM_DARK} />
                    <Text style={{ color: CREAM_DARK, marginTop: 8, fontSize: 14 }}>No photo</Text>
                  </View>
                </View>
              );
            }

            if (urls.length === 1) {
              return (
                <TouchableOpacity
                  style={styles.imageSlide}
                  activeOpacity={0.9}
                  onPress={() => openZoomForSpotItem(item, urls)}
                >
                  <ExpoImage
                    source={{ uri: urls[0] }}
                    style={styles.image}
                    contentFit="cover"
                    transition={150}
                  />
                </TouchableOpacity>
              );
            }

            return (
              <View style={styles.imageSlide}>
                <ScrollView
                  horizontal
                  pagingEnabled
                  showsHorizontalScrollIndicator={false}
                  nestedScrollEnabled
                  keyboardShouldPersistTaps="handled"
                  onMomentumScrollEnd={(e) => {
                    const raw = Math.round(e.nativeEvent.contentOffset.x / width);
                    const clamped = Math.min(Math.max(0, raw), urls.length - 1);
                    if (spots[safeIndex]?.id === item.id) {
                      setInnerPhotoIndex(clamped);
                    }
                  }}
                >
                  {urls.map((uri, uidx) => (
                    <TouchableOpacity
                      key={`${item.id}-${uidx}`}
                      style={{ width, height: 260 }}
                      activeOpacity={0.9}
                      onPress={() => openZoomForSpotItem(item, urls)}
                    >
                      <ExpoImage
                        source={{ uri }}
                        style={styles.image}
                        contentFit="cover"
                        transition={150}
                      />
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            );
          }}
        />

        <LinearGradient
          pointerEvents="none"
          colors={['rgba(7,15,24,0.82)', 'rgba(7,15,24,0.45)', 'transparent']}
          locations={[0, 0.4, 1]}
          style={styles.imageTopScrim}
        />

        {/* Subtle scrim + overlaid actions: keeps the sheet compact; gradient is
            non-interactive so horizontal swipes on the photo still scroll the carousel. */}
        <LinearGradient
          pointerEvents="none"
          colors={['transparent', 'rgba(7,15,24,0.55)', 'rgba(7,15,24,0.82)']}
          locations={[0, 0.45, 1]}
          style={styles.imageBottomScrim}
        />

        {spots.length > 1 && (
          <View style={styles.dotsRowOverlay} pointerEvents="none">
            {spots.map((s, i) => (
              <View
                key={s.id}
                style={[
                  styles.dot,
                  {
                    backgroundColor: i === safeIndex ? ORANGE : 'rgba(231,219,203,0.35)',
                    width: i === safeIndex ? 18 : 6,
                  },
                ]}
              />
            ))}
          </View>
        )}

        {peekMultiPhoto && spots.length > 1 && (
          <View style={styles.innerCountBadgeBottom} pointerEvents="none">
            <Text style={styles.countText}>
              {Math.min(innerPhotoIndex, Math.max(0, peekGalleryUrls.length - 1)) + 1} /{' '}
              {peekGalleryUrls.length}
            </Text>
          </View>
        )}

        {/* Close + actions on the photo (same pattern as bottom actions). */}
        <View style={styles.imageTopChrome} pointerEvents="box-none">
          <View style={styles.imageTopRow} pointerEvents="box-none">
            <TouchableOpacity onPress={onClose} style={styles.topBarButton}>
              <Ionicons name="close" size={24} color={CREAM} />
            </TouchableOpacity>

            <View style={styles.imageTopCenter} pointerEvents="none">
              {spots.length > 1 ? (
                <View style={styles.countBadgePill}>
                  <Text style={styles.countText}>
                    {safeIndex + 1} / {spots.length}
                  </Text>
                </View>
              ) : peekMultiPhoto ? (
                <View style={styles.countBadgePill}>
                  <Text style={styles.countText}>
                    {Math.min(innerPhotoIndex, Math.max(0, peekGalleryUrls.length - 1)) + 1} /{' '}
                    {peekGalleryUrls.length}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.topBarRight}>
              {!isOwner && onBlock ? (
                <TouchableOpacity
                  style={[styles.topBarButton, { marginRight: 8 }]}
                  onPress={() => onBlock(spot)}
                  accessibilityLabel="Block user"
                >
                  <Ionicons name="ban-outline" size={22} color={CREAM_DARK} />
                </TouchableOpacity>
              ) : null}
              {isOwner && onEdit ? (
                <TouchableOpacity
                  style={[styles.topBarButton, { marginRight: 8 }]}
                  onPress={() => {
                    onClose();
                    onEdit(spot);
                  }}
                  accessibilityLabel="Edit spot"
                >
                  <Ionicons name="create-outline" size={22} color={CREAM} />
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity
                style={styles.topBarButton}
                onPress={() => (isOwner ? onDelete(spot) : onReport(spot))}
                accessibilityLabel={isOwner ? 'Delete spot' : 'Report spot'}
              >
                <Ionicons
                  name={isOwner ? 'trash-outline' : 'flag-outline'}
                  size={22}
                  color={isOwner ? DANGER : CREAM_DARK}
                />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={styles.imageActionsOverlay} pointerEvents="box-none">
          <View style={styles.imageActionsBar} pointerEvents="box-none">
            <View style={styles.imageActionsLeft} pointerEvents="box-none">
              {!!currentUserId ? (
                <TouchableOpacity
                  onPress={() => void handleToggleLike()}
                  style={[styles.likeHeartPill, likedByMe && styles.likeHeartPillLiked]}
                  activeOpacity={0.85}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                >
                  <Ionicons
                    name={likedByMe ? 'heart' : 'heart-outline'}
                    size={20}
                    color={likedByMe ? DANGER : CREAM}
                  />
                  <Text style={styles.likeCountInline}>{likeCount}</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.likeHeartPill} pointerEvents="none">
                  <Ionicons name="heart-outline" size={20} color={CREAM_DARK} />
                  <Text style={styles.likeCountInline}>{likeCount}</Text>
                </View>
              )}
              <TouchableOpacity
                onPress={() => {
                  Keyboard.dismiss();
                  setCommentsModalOpen(true);
                }}
                style={[styles.actionButton, styles.commentsActionBtn]}
                activeOpacity={0.85}
                hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                accessibilityRole="button"
                accessibilityLabel={
                  commentTotalCount > 0
                    ? `Comments, ${commentTotalCount}`
                    : 'Comments, none yet'
                }
              >
                <Ionicons name="chatbubble-ellipses-outline" size={20} color={CREAM} />
                {commentTotalCount > 0 ? (
                  <View style={styles.commentsBadge} accessibilityElementsHidden>
                    <Text style={styles.commentsBadgeText}>
                      {commentTotalCount > 99 ? '99+' : String(commentTotalCount)}
                    </Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            </View>
            <View style={styles.imageActionsRight} pointerEvents="box-none">
              {!!currentUserId && (
                <TouchableOpacity
                  onPress={() => void handleToggleBookmark()}
                  style={[styles.actionButton, isBookmarked && styles.actionButtonBm]}
                >
                  <Ionicons
                    name={isBookmarked ? 'bookmark' : 'bookmark-outline'}
                    size={20}
                    color={CREAM}
                  />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={() => void shareSpot(spot)}
                style={styles.actionButton}
                hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }}
              >
                <Ionicons name="share-outline" size={20} color={CREAM} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => openDirections(spot)} style={styles.actionButton}>
                <Ionicons name="navigate-outline" size={20} color={CREAM} />
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>

      {/* ---- Info section ---- */}
      <ScrollView
        style={styles.info}
        contentContainerStyle={{ paddingBottom: 28 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            {spot.title ? (
              <Text style={styles.title} numberOfLines={2}>
                {spot.title}
              </Text>
            ) : (
              <Text style={[styles.title, styles.titleUntitled]}>Untitled Spot</Text>
            )}

            {/* Posted-by row: hidden for private authors until the viewer follows them. */}
            {showPostedByAttribution ? (
              <Text style={styles.postedBy}>
                Posted by{' '}
                <Text
                  style={styles.postedByName}
                  onPress={
                    showUsernameLink && spot.username ? handleUsernamePress : undefined
                  }
                  suppressHighlighting={!showUsernameLink}
                >
                  @{spot.username || 'anonymous'}
                </Text>
              </Text>
            ) : null}
          </View>
        </View>

        {!!spot.address && (
          <View style={styles.addressRow}>
            <Ionicons
              name="location-outline"
              size={14}
              color={ORANGE}
              style={{ marginRight: 5, marginTop: 1 }}
            />
            <Text style={styles.address} numberOfLines={2}>
              {spot.address}
            </Text>
          </View>
        )}

        {!!spot.caption && <Text style={styles.caption}>{spot.caption}</Text>}

        {spot.tags && spot.tags.length > 0 && (
          <View style={styles.tagsRow}>
            {spot.tags.map((tag) => {
              const TagInner = (
                <Text style={styles.tagText}>{tag}</Text>
              );
              return onTagPress ? (
                <TouchableOpacity
                  key={tag}
                  style={styles.tag}
                  onPress={() => onTagPress(tag)}
                  activeOpacity={0.7}
                >
                  {TagInner}
                </TouchableOpacity>
              ) : (
                <View key={tag} style={styles.tag}>
                  {TagInner}
                </View>
              );
            })}
          </View>
        )}

      </ScrollView>

      <Modal
        visible={commentsModalOpen}
        animationType="slide"
        transparent
        onRequestClose={closeCommentsModal}
      >
        <KeyboardAvoidingView
          style={styles.commentsModalRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.commentsModalOuter}>
            <Pressable style={styles.commentsModalBackdrop} onPress={closeCommentsModal} />
            <View style={[styles.commentsModalSheet, { backgroundColor: sheetBg, maxHeight: WIN_H * 0.88 }]}>
              <View style={styles.commentsModalHeader}>
                <Text style={styles.commentsModalTitle} numberOfLines={1}>
                  Comments{commentTotalCount > 0 ? ` · ${commentTotalCount}` : ''}
                </Text>
                <TouchableOpacity
                  onPress={closeCommentsModal}
                  style={styles.commentsModalClose}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  accessibilityLabel="Close comments"
                >
                  <Ionicons name="close" size={26} color={CREAM} />
                </TouchableOpacity>
              </View>

            <FlatList
              ref={commentsListRef}
              style={{ maxHeight: WIN_H * 0.52 }}
              data={flatCommentRows}
              keyExtractor={(item) => item.c.id}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
              contentContainerStyle={
                flatCommentRows.length === 0
                  ? [styles.commentsModalScrollContent, { flexGrow: 1 }]
                  : styles.commentsModalScrollContent
              }
              ListEmptyComponent={
                <Text style={styles.commentsEmpty}>No comments yet.</Text>
              }
              renderItem={({ item }) =>
                renderCommentRow(
                  item.c,
                  { isReply: item.isReply, showReply: item.showReply },
                  pulseCommentId === item.c.id,
                  item.threadEnd
                )
              }
              onScrollToIndexFailed={(info) => {
                setTimeout(() => {
                  commentsListRef.current?.scrollToIndex({
                    index: info.index,
                    viewPosition: 0.35,
                    animated: true,
                  });
                }, 200);
              }}
            />

            <View style={styles.commentsModalFooter}>
              {!currentUserId ? (
                <Text style={styles.commentsHintInModal}>Sign in to leave a comment.</Text>
              ) : !viewerCommentUsername ? (
                <Text style={styles.commentsHintInModal}>Set a username on your profile to comment.</Text>
              ) : (
                <View style={[styles.commentComposerWrap, styles.commentComposerInModal]}>
                  {replyParentId ? (
                    <View style={styles.replyBanner}>
                      <Text style={styles.replyBannerText} numberOfLines={1}>
                        Replying to @{replyParentUsername || 'user'}
                      </Text>
                      <TouchableOpacity
                        onPress={() => {
                          setReplyParentId(null);
                          setReplyParentUsername(null);
                        }}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                        accessibilityLabel="Cancel reply"
                      >
                        <Ionicons name="close-circle" size={22} color={CREAM_DARK} />
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  <View style={styles.commentComposerRow}>
                    <TextInput
                      style={[
                        styles.commentInput,
                        {
                          borderColor: isDark ? 'rgba(231,219,203,0.18)' : 'rgba(231,219,203,0.28)',
                          color: CREAM,
                          backgroundColor: isDark ? 'rgba(0,0,0,0.22)' : 'rgba(17,35,55,0.35)',
                        },
                      ]}
                      placeholder={
                        replyParentId ? `Reply to @${replyParentUsername || 'user'}…` : 'Add a comment…'
                      }
                      placeholderTextColor={CREAM_DARK}
                      value={commentDraft}
                      onChangeText={setCommentDraft}
                      multiline={false}
                      maxLength={SPOT_COMMENT_MAX_LEN}
                      editable={!commentSending}
                      returnKeyType="send"
                      blurOnSubmit
                      enablesReturnKeyAutomatically
                      onSubmitEditing={() => void handleSendComment()}
                    />
                    <TouchableOpacity
                      style={[
                        styles.commentSendBtn,
                        (!commentDraft.trim() || commentSending) && styles.commentSendBtnDisabled,
                      ]}
                      onPress={() => void handleSendComment()}
                      disabled={!commentDraft.trim() || commentSending}
                      accessibilityLabel="Send comment"
                    >
                      {commentSending ? (
                        <ActivityIndicator size="small" color={CREAM} />
                      ) : (
                        <Ionicons name="send" size={18} color={CREAM} />
                      )}
                    </TouchableOpacity>
                  </View>
                </View>
              )}
            </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ---- Fullscreen pinch-to-zoom photo viewer ---- */}
      <ImageView
        images={zoomImages}
        imageIndex={zoomImageIndex}
        visible={zoomVisible}
        onRequestClose={() => setZoomVisible(false)}
        onImageIndexChange={setZoomImageIndex}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    bottom: 0,
    width: '100%',
    maxHeight: '85%',
    zIndex: 50,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -6 },
    elevation: 24,
    borderTopWidth: 1,
    borderColor: 'rgba(227,92,37,0.25)',
  },

  // Top chrome on the photo (close + spot / photo count + owner / report actions)
  imageTopScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 96,
    zIndex: 4,
  },
  imageTopChrome: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 10,
    paddingTop: 10,
    paddingHorizontal: 12,
    paddingBottom: 6,
  },
  imageTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  imageTopCenter: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  topBarButton: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    padding: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.15)',
  },

  // Image carousel
  imageContainer: { position: 'relative' },
  imageSlide: { width, height: 260 },
  image: { width: '100%', height: '100%' },
  imagePlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(17,35,55,0.8)',
  },

  imageBottomScrim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 100,
    zIndex: 4,
  },

  // Bookmark / like / share / directions — overlaid on the photo bottom; outer
  // uses box-none so swipes on the image still reach the FlatList outside the buttons.
  imageActionsOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 8,
    paddingBottom: 10,
    paddingHorizontal: 12,
    paddingTop: 28,
  },
  imageActionsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    gap: 12,
  },
  imageActionsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    gap: 8,
  },
  imageActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: 8,
    flexShrink: 1,
  },
  /** Heart + count on the bottom-left of the photo (read-only pill when not signed in). */
  likeHeartPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: 'rgba(17,35,55,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.2)',
  },
  likeHeartPillLiked: {
    backgroundColor: 'rgba(255,59,48,0.15)',
    borderColor: 'rgba(255,59,48,0.4)',
  },
  likeCountInline: { color: CREAM, fontSize: 13, fontWeight: '800', minWidth: 16, textAlign: 'left' },
  countBadgePill: {
    backgroundColor: 'rgba(17,35,55,0.75)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.4)',
  },
  innerCountBadgeBottom: {
    position: 'absolute',
    bottom: 52,
    left: 14,
    zIndex: 9,
    backgroundColor: 'rgba(17,35,55,0.75)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.4)',
  },
  countText: { color: CREAM, fontSize: 12, fontWeight: '700' },
  // Dot indicators (multi-spot only) — on the image, above the action chips
  dotsRowOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 50,
    zIndex: 7,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 5,
  },
  dot: { height: 6, borderRadius: 3 },

  actionButton: {
    backgroundColor: 'rgba(17,35,55,0.7)',
    padding: 9,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(231,219,203,0.2)',
  },
  actionButtonBm: {
    backgroundColor: 'rgba(227,92,37,0.25)',
    borderColor: 'rgba(227,92,37,0.5)',
  },

  // Info section
  info: { paddingHorizontal: 18, paddingTop: 4 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 6 },
  title: { fontSize: 18, fontWeight: '800', color: CREAM, marginBottom: 3, letterSpacing: 0.2 },
  titleUntitled: { color: CREAM_DARK, fontStyle: 'italic' },
  postedBy: { fontSize: 13, color: CREAM_DARK },
  postedByName: { color: ORANGE, fontWeight: '700' },
  addressRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  address: { fontSize: 13, flex: 1, lineHeight: 18, color: CREAM_DARK },
  caption: { fontSize: 14, lineHeight: 20, marginBottom: 10, color: CREAM_DARK },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: 'rgba(227,92,37,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.35)',
  },
  tagText: { fontSize: 12, fontWeight: '700', color: ORANGE },

  commentsActionBtn: { position: 'relative' },
  commentsBadge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: ORANGE,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(7,15,24,0.95)',
  },
  commentsBadgeText: { fontSize: 10, fontWeight: '800', color: CREAM, lineHeight: 12 },

  commentsModalRoot: { flex: 1 },
  commentsModalOuter: { flex: 1, justifyContent: 'flex-end' },
  commentsModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  commentsModalSheet: {
    width: '100%',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderTopWidth: 1,
    borderColor: 'rgba(227,92,37,0.3)',
    overflow: 'hidden',
  },
  commentsModalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(231,219,203,0.18)',
  },
  commentsModalTitle: { flex: 1, fontSize: 18, fontWeight: '800', color: CREAM },
  commentsModalClose: { marginLeft: 8 },
  commentsModalScroll: { flexGrow: 0 },
  commentsModalScrollContent: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  commentsModalFooter: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 22,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(231,219,203,0.18)',
  },
  commentsHintInModal: { fontSize: 13, color: CREAM_DARK, lineHeight: 18, marginBottom: 4 },
  commentComposerInModal: { marginTop: 0 },

  commentsEmpty: { fontSize: 13, color: CREAM_DARK, marginBottom: 12 },
  commentThread: { marginBottom: 16 },
  igCommentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    width: '100%',
    marginBottom: 12,
  },
  igCommentRowReply: {
    marginLeft: 24,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(227,92,37,0.28)',
  },
  igCommentRowHighlight: {
    backgroundColor: 'rgba(227,92,37,0.14)',
    borderRadius: 12,
    marginHorizontal: -4,
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  igCommentRowThreadEnd: { marginBottom: 16 },
  igCommentPressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    minWidth: 0,
    paddingRight: 4,
  },
  igAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(231,219,203,0.1)',
  },
  igAvatarPlaceholder: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  igCommentTextCol: {
    flex: 1,
    minWidth: 0,
    marginLeft: 10,
  },
  igCommentMainLine: {
    flexWrap: 'wrap',
    color: CREAM,
  },
  igCommentUsername: {
    fontSize: 14,
    fontWeight: '800',
    color: CREAM,
  },
  igCommentBody: {
    fontSize: 15,
    fontWeight: '400',
    color: CREAM,
    lineHeight: 21,
  },
  igCommentBodyReply: {
    fontSize: 14,
    lineHeight: 20,
  },
  igCommentMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 4,
  },
  igCommentTime: {
    fontSize: 12,
    fontWeight: '600',
    color: CREAM_DARK,
  },
  igCommentMetaDot: {
    fontSize: 12,
    color: CREAM_DARK,
  },
  igReplyLink: {
    fontSize: 12,
    fontWeight: '700',
    color: CREAM,
  },
  igHeartColumn: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 2,
    minWidth: 36,
  },
  igHeartCount: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '800',
    color: CREAM,
  },
  igHeartCountMuted: {
    marginTop: 2,
    fontSize: 11,
    fontWeight: '800',
    color: CREAM_DARK,
  },
  commentComposerWrap: { marginTop: 14 },
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: 'rgba(227,92,37,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.25)',
  },
  replyBannerText: { flex: 1, fontSize: 13, fontWeight: '700', color: CREAM },
  commentComposerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  commentInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 48,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    lineHeight: 20,
  },
  commentSendBtn: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: ORANGE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  commentSendBtnDisabled: { opacity: 0.45 },
});
