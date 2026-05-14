// ============================================================
// FeedSpotComments.tsx — Compact comments strip for feed cards
// ------------------------------------------------------------
// Live Firestore thread (same model as SpotPeek), likes, reply,
// and composer. Intended for a fixed-height panel under the photo.
// ============================================================

import { Ionicons } from '@expo/vector-icons';
import { Image as ExpoImage } from 'expo-image';
import { useRouter } from 'expo-router';
import {
  collection,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
} from 'firebase/firestore';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { BRAND } from '../constants/brand';
import { db } from '../utils/firebase';
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

const { orange: ORANGE, cream: CREAM, creamDark: CREAM_DARK, danger: DANGER } = BRAND;

const FETCH = 24;

type FeedSpotCommentsProps = {
  spotId: string;
  spotOwnerUid: string;
  viewerUid: string;
  isDark: boolean;
};

function mapDoc(id: string, data: Record<string, unknown>): SpotCommentRow {
  return {
    id,
    userId: String(data.userId ?? ''),
    username: String(data.username ?? ''),
    text: String(data.text ?? ''),
    parentCommentId:
      typeof data.parentCommentId === 'string' && data.parentCommentId.trim()
        ? data.parentCommentId.trim()
        : undefined,
    createdAt: data.createdAt as SpotCommentRow['createdAt'],
  };
}

export default function FeedSpotComments({
  spotId,
  spotOwnerUid,
  viewerUid,
  isDark,
}: FeedSpotCommentsProps) {
  const router = useRouter();
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [spotComments, setSpotComments] = useState<SpotCommentRow[]>([]);
  const [commentDraft, setCommentDraft] = useState('');
  const [commentSending, setCommentSending] = useState(false);
  const [viewerCommentUsername, setViewerCommentUsername] = useState('');
  const [replyParentId, setReplyParentId] = useState<string | null>(null);
  const [replyParentUsername, setReplyParentUsername] = useState<string | null>(null);
  const [commentLikeMap, setCommentLikeMap] = useState<Record<string, { count: number; liked: boolean }>>(
    {}
  );
  const [commentAvatars, setCommentAvatars] = useState<Record<string, string | null>>({});
  const commentAvatarFetchedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setCommentsOpen(false);
    setCommentDraft('');
    setReplyParentId(null);
    setReplyParentUsername(null);
    setSpotComments([]);
    setCommentLikeMap({});
    setCommentAvatars({});
    commentAvatarFetchedRef.current = new Set();
  }, [spotId]);

  useEffect(() => {
    if (!viewerUid) {
      setViewerCommentUsername('');
      return;
    }
    let cancelled = false;
    void getDoc(doc(db, 'users', viewerUid)).then((snap) => {
      if (cancelled) return;
      const u = (snap.data()?.username as string | undefined)?.trim().toLowerCase() ?? '';
      setViewerCommentUsername(u);
    });
    return () => {
      cancelled = true;
    };
  }, [viewerUid]);

  useEffect(() => {
    if (!spotId || !commentsOpen) return;
    const q = query(
      collection(db, 'spots', spotId, 'comments'),
      orderBy('createdAt', 'desc'),
      limit(FETCH)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const chronological = [...snap.docs].reverse().map((d) => mapDoc(d.id, d.data()));
        setSpotComments(chronological);
      },
      (e) => {
        captureError(e, { area: 'FeedSpotComments.query', spotId });
      }
    );
    return () => unsub();
  }, [spotId, commentsOpen]);

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

  useEffect(() => {
    if (!spotId || !commentsOpen || !commentIdsKey) {
      setCommentLikeMap({});
      return;
    }
    const ids = commentIdsKey.split('|').filter(Boolean);
    if (ids.length === 0) {
      setCommentLikeMap({});
      return;
    }
    const me = viewerUid || '';
    const unsubs = ids.map((id) =>
      onSnapshot(
        collection(db, 'spots', spotId, 'comments', id, 'likes'),
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
          captureError(e, { area: 'FeedSpotComments.commentLikes', commentId: id });
        }
      )
    );
    return () => {
      unsubs.forEach((u) => u());
    };
  }, [spotId, commentsOpen, commentIdsKey, viewerUid]);

  useEffect(() => {
    if (!commentsOpen) return;
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
              if (!s.exists()) return [uid, null, true] as const;
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
  }, [spotComments, commentsOpen]);

  /** Continuation of the card — close to overlay scrim, not a second “skin”. */
  const panelBg = isDark ? 'rgba(10,18,30,0.92)' : 'rgba(14,26,42,0.94)';
  const threadWell = isDark ? 'rgba(255,255,255,0.055)' : 'rgba(255,255,255,0.07)';
  const threadBorder = isDark ? 'rgba(231,219,203,0.08)' : 'rgba(231,219,203,0.12)';

  const openProfile = (uname: string) => {
    const slug = uname.trim().toLowerCase();
    if (!slug) return;
    router.push(`/user/${slug}`);
  };

  const handleSendComment = async () => {
    if (!viewerUid || !spotId || !viewerCommentUsername) return;
    const trimmed = commentDraft.trim();
    if (!trimmed || commentSending) return;
    setCommentSending(true);
    try {
      await addSpotComment(spotId, trimmed, viewerUid, viewerCommentUsername, replyParentId);
      setCommentDraft('');
      setReplyParentId(null);
      setReplyParentUsername(null);
      Keyboard.dismiss();
    } catch (e) {
      captureError(e, { area: 'FeedSpotComments.addComment', spotId });
      Alert.alert('Could not post', 'Check your connection and try again.');
    } finally {
      setCommentSending(false);
    }
  };

  const performDeleteComment = (c: SpotCommentRow) => {
    if (!spotId) return;
    const op = c.parentCommentId
      ? deleteSpotComment(spotId, c.id)
      : deleteSpotCommentThread(spotId, c.id);
    void op.catch((err) => {
      captureError(err, { area: 'FeedSpotComments.deleteComment', commentId: c.id });
      Alert.alert('Could not delete', 'Please try again.');
    });
  };

  const openCommentLongPressMenu = (c: SpotCommentRow) => {
    if (!spotId || !viewerUid) return;
    const isAuthor = c.userId === viewerUid;
    const isSpotOwner = spotOwnerUid === viewerUid;
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

  const handleToggleCommentLike = async (commentId: string, liked: boolean) => {
    if (!viewerUid || !spotId) return;
    try {
      await toggleCommentLike(spotId, commentId, liked);
    } catch (e) {
      captureError(e, { area: 'FeedSpotComments.toggleCommentLike', commentId });
    }
  };

  const renderRow = (
    c: SpotCommentRow,
    { isReply, showReply }: { isReply: boolean; showReply: boolean }
  ) => {
    const canDelete =
      !!viewerUid && (c.userId === viewerUid || spotOwnerUid === viewerUid);
    const lk = commentLikeMap[c.id] ?? { count: 0, liked: false };
    const avatarUri = c.userId ? commentAvatars[c.userId] : undefined;
    const uname = (c.username || 'user').trim();

    return (
      <View style={[styles.feedCommentRow, isReply && styles.feedCommentRowReply]}>
        <Pressable
          style={styles.feedCommentPressable}
          onLongPress={canDelete ? () => openCommentLongPressMenu(c) : undefined}
          delayLongPress={450}
          accessibilityHint={canDelete ? 'Hold to show delete options' : undefined}
        >
          <TouchableOpacity
            onPress={() => openProfile(c.username)}
            activeOpacity={0.85}
            accessibilityLabel={`Open profile @${uname}`}
          >
            {avatarUri ? (
              <ExpoImage source={{ uri: avatarUri }} style={styles.feedAvatar} contentFit="cover" />
            ) : (
              <View style={[styles.feedAvatar, styles.feedAvatarPh]}>
                <Ionicons name="person" size={12} color="rgba(231,219,203,0.45)" />
              </View>
            )}
          </TouchableOpacity>
          <View style={[styles.feedTextCol, isReply && styles.feedTextColReply]}>
            <Text style={styles.feedMainLine} numberOfLines={isReply ? 3 : 4}>
              <Text
                style={styles.feedUname}
                onPress={() => openProfile(c.username)}
                suppressHighlighting={!c.username}
              >
                {uname}{' '}
              </Text>
              <Text style={styles.feedBody}>{c.text}</Text>
            </Text>
            <View style={styles.feedMetaRow}>
              <Text style={styles.feedTime}>{formatSpotCommentTime(c.createdAt)}</Text>
              {showReply && !!viewerUid && !!viewerCommentUsername ? (
                <>
                  <Text style={styles.feedMetaDot}> · </Text>
                  <Pressable
                    onPress={() => {
                      setReplyParentId(c.id);
                      setReplyParentUsername(c.username || null);
                    }}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Reply to comment"
                  >
                    <Text style={styles.feedReply}>Reply</Text>
                  </Pressable>
                </>
              ) : null}
            </View>
          </View>
        </Pressable>
        {!!viewerUid ? (
          <TouchableOpacity
            style={styles.feedHeartCol}
            onPress={() => void handleToggleCommentLike(c.id, lk.liked)}
            hitSlop={{ top: 8, bottom: 8, left: 6, right: 4 }}
            accessibilityLabel={lk.liked ? 'Unlike comment' : 'Like comment'}
          >
            <Ionicons
              name={lk.liked ? 'heart' : 'heart-outline'}
              size={17}
              color={lk.liked ? DANGER : 'rgba(231,219,203,0.55)'}
            />
            {lk.count > 0 ? <Text style={styles.feedHeartCt}>{lk.count}</Text> : null}
          </TouchableOpacity>
        ) : (
          <View style={styles.feedHeartCol} pointerEvents="none" accessibilityElementsHidden>
            <Ionicons name="heart-outline" size={17} color="rgba(231,219,203,0.45)" />
            {lk.count > 0 ? <Text style={styles.feedHeartCtMuted}>{lk.count}</Text> : null}
          </View>
        )}
      </View>
    );
  };

  const commentCount = spotComments.length;

  return (
    <View style={[styles.panel, { backgroundColor: panelBg }]}>
      <TouchableOpacity
        style={styles.toggleRow}
        onPress={() => {
          Keyboard.dismiss();
          setCommentsOpen((prev) => !prev);
        }}
        activeOpacity={0.82}
        accessibilityRole="button"
        accessibilityLabel={commentsOpen ? 'Hide comments' : 'Show comments'}
      >
        <Ionicons name="chatbubbles-outline" size={19} color="rgba(231,219,203,0.65)" />
        <Text style={styles.toggleLabel}>{commentsOpen ? 'Hide comments' : 'Comments'}</Text>
        {commentCount > 0 ? (
          <View style={styles.toggleCountPill}>
            <Text style={styles.toggleCountText}>{commentCount > 99 ? '99+' : String(commentCount)}</Text>
          </View>
        ) : null}
        <View style={{ flex: 1, minWidth: 8 }} />
        <Ionicons
          name={commentsOpen ? 'chevron-up' : 'chevron-down'}
          size={20}
          color="rgba(231,219,203,0.45)"
        />
      </TouchableOpacity>

      {commentsOpen ? (
        <>
          <ScrollView
            style={styles.list}
            contentContainerStyle={styles.listContent}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {commentThreads.length === 0 ? (
              <Text style={styles.empty}>No comments yet</Text>
            ) : (
              commentThreads.map(({ root, replies }) => (
                <View
                  key={root.id}
                  style={[
                    styles.thread,
                    { backgroundColor: threadWell, borderColor: threadBorder },
                  ]}
                >
                  {renderRow(root, { isReply: false, showReply: true })}
                  {replies.map((r) => (
                    <View key={r.id}>{renderRow(r, { isReply: true, showReply: false })}</View>
                  ))}
                </View>
              ))
            )}
          </ScrollView>

          {!viewerUid ? (
            <Text style={styles.hint}>Sign in to comment.</Text>
          ) : !viewerCommentUsername ? (
            <Text style={styles.hint}>Set a username on your profile to comment.</Text>
          ) : (
            <View>
              {replyParentId ? (
                <View style={styles.replyBanner}>
                  <Text style={styles.replyBannerTxt} numberOfLines={1}>
                    Replying to @{replyParentUsername || 'user'}
                  </Text>
                  <TouchableOpacity
                    onPress={() => {
                      setReplyParentId(null);
                      setReplyParentUsername(null);
                    }}
                    hitSlop={10}
                  >
                    <Ionicons name="close-circle" size={20} color={CREAM_DARK} />
                  </TouchableOpacity>
                </View>
              ) : null}
              <View style={styles.composer}>
                <TextInput
                  style={[
                    styles.input,
                    {
                      borderColor: 'rgba(231,219,203,0.14)',
                      color: CREAM,
                      backgroundColor: isDark ? 'rgba(0,0,0,0.28)' : 'rgba(0,0,0,0.18)',
                    },
                  ]}
                  placeholder={replyParentId ? 'Write a reply…' : 'Add a comment…'}
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
                  style={[styles.send, (!commentDraft.trim() || commentSending) && styles.sendOff]}
                  onPress={() => void handleSendComment()}
                  disabled={!commentDraft.trim() || commentSending}
                  accessibilityLabel="Send comment"
                >
                  {commentSending ? (
                    <ActivityIndicator size="small" color={CREAM} />
                  ) : (
                    <Ionicons name="send" size={16} color={CREAM} />
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(231,219,203,0.07)',
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 10,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: 'rgba(231,219,203,0.92)',
    letterSpacing: 0.15,
  },
  toggleCountPill: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    backgroundColor: 'rgba(227,92,37,0.35)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  toggleCountText: { fontSize: 11, fontWeight: '900', color: CREAM },
  list: { maxHeight: 150, marginTop: 6 },
  listContent: { paddingBottom: 2 },
  empty: { fontSize: 13, color: 'rgba(231,219,203,0.42)', paddingVertical: 4 },
  thread: {
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  feedCommentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    width: '100%',
    marginBottom: 4,
  },
  feedCommentRowReply: { marginTop: 6 },
  feedCommentPressable: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    minWidth: 0,
    paddingRight: 4,
  },
  feedAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(231,219,203,0.1)',
  },
  feedAvatarPh: { justifyContent: 'center', alignItems: 'center' },
  feedTextCol: { flex: 1, minWidth: 0, marginLeft: 8 },
  feedTextColReply: {
    marginLeft: 4,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: 'rgba(227,92,37,0.28)',
  },
  feedMainLine: { flexWrap: 'wrap', color: 'rgba(231,219,203,0.88)' },
  feedUname: { fontSize: 13, fontWeight: '800', color: ORANGE },
  feedBody: { fontSize: 13, fontWeight: '400', color: 'rgba(231,219,203,0.82)', lineHeight: 18 },
  feedMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginTop: 3,
  },
  feedTime: { fontSize: 11, fontWeight: '600', color: 'rgba(231,219,203,0.45)' },
  feedMetaDot: { fontSize: 11, color: 'rgba(231,219,203,0.35)' },
  feedReply: { fontSize: 11, fontWeight: '700', color: ORANGE },
  feedHeartCol: {
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 2,
    minWidth: 32,
  },
  feedHeartCt: {
    marginTop: 1,
    fontSize: 10,
    fontWeight: '800',
    color: 'rgba(231,219,203,0.65)',
  },
  feedHeartCtMuted: {
    marginTop: 1,
    fontSize: 10,
    fontWeight: '800',
    color: 'rgba(231,219,203,0.4)',
  },
  hint: { fontSize: 12, color: 'rgba(231,219,203,0.45)', marginTop: 6 },
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 12,
    backgroundColor: 'rgba(227,92,37,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(227,92,37,0.2)',
  },
  replyBannerTxt: { flex: 1, fontSize: 12, fontWeight: '600', color: 'rgba(231,219,203,0.9)' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, marginTop: 4 },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 40,
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 14,
    lineHeight: 20,
  },
  send: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: ORANGE,
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendOff: { opacity: 0.45 },
});
