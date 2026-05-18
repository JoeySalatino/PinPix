/** Shared push notification titles and bodies (Cloud Functions → Expo). */

export function trunc(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function followRequestBody(actorName: string): { title: string; body: string } {
  return {
    title: 'Follow request',
    body: `@${trunc(actorName, 22)} requested to follow you`,
  };
}

export function followRequestAcceptedBody(accepterName: string): { title: string; body: string } {
  return {
    title: 'Request accepted',
    body: `@${trunc(accepterName, 22)} accepted your follow request`,
  };
}

export function newFollowerBody(followerName: string): { title: string; body: string } {
  return {
    title: 'New follower',
    body: `@${trunc(followerName, 22)} started following you`,
  };
}

export function nearbySpotBody(spotTitle: string, actorName: string): { title: string; body: string } {
  return {
    title: 'New spot nearby',
    body: `${trunc(spotTitle, 48)} — by @${trunc(actorName, 20)}`,
  };
}

export function spotLikedBody(likerName: string, spotTitle: string): { title: string; body: string } {
  return {
    title: 'Spot activity',
    body: `@${trunc(likerName, 22)} liked ${trunc(spotTitle, 40)}`,
  };
}

export function spotSavedBody(actorName: string, spotTitle: string): { title: string; body: string } {
  return {
    title: 'Spot activity',
    body: `@${trunc(actorName, 22)} saved ${trunc(spotTitle, 40)}`,
  };
}

export function commentOnSpotBody(actorName: string, spotTitle: string): { title: string; body: string } {
  return {
    title: 'New comment',
    body: `@${trunc(actorName, 20)} commented on ${trunc(spotTitle, 42)}`,
  };
}

export function replyToCommentBody(actorName: string, spotTitle: string): { title: string; body: string } {
  return {
    title: 'New reply',
    body: `@${trunc(actorName, 20)} replied to your comment on ${trunc(spotTitle, 34)}`,
  };
}

export function replyOnSpotBody(actorName: string, spotTitle: string): { title: string; body: string } {
  return {
    title: 'New reply',
    body: `@${trunc(actorName, 20)} replied on ${trunc(spotTitle, 40)}`,
  };
}

export function mentionOnSpotBody(actorName: string, spotTitle: string): { title: string; body: string } {
  return {
    title: 'Mentioned you',
    body: `@${trunc(actorName, 20)} mentioned you on ${trunc(spotTitle, 36)}`,
  };
}

export function commentLikedBody(likerName: string, spotTitle: string): { title: string; body: string } {
  return {
    title: 'Comment liked',
    body: `@${trunc(likerName, 20)} liked your comment on ${trunc(spotTitle, 36)}`,
  };
}
