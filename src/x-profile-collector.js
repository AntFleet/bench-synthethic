const RESERVED_SEGMENTS = new Set([
  'home', 'explore', 'search', 'notifications', 'messages', 'i', 'settings', 'compose', 'intent', 'share', 'tos', 'privacy', 'login', 'signup', 'hashtag', 'communities'
]);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'your', 'about', 'into', 'their', 'they', 'them', 'just', 'have', 'will', 'would', 'there', 'here', 'more', 'than', 'when', 'what', 'where', 'why', 'how', 'you', 'our', 'out', 'all', 'are', 'but', 'not', 'too', 'its', "it's", 'http', 'https', 'www', 'com', 'co', 'amp', 'was', 'were', 'has', 'had', 'new', 'can', 'get', 'got'
]);

export function isXProfileUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(url.hostname)) return false;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return false;
    const handle = parts[0]?.replace(/^@/, '');
    return Boolean(handle && !RESERVED_SEGMENTS.has(handle.toLowerCase()));
  } catch {
    return false;
  }
}

export async function collectXProfileSignals(rawUrl, options = {}) {
  const parsed = parseXProfileUrl(rawUrl);
  if (!parsed) {
    return {
      ok: false,
      source: 'x-profile',
      url: String(rawUrl),
      error: 'not an X profile URL',
      objections: [],
      marketSignals: [],
      socialSignals: [],
      recentPosts: [],
      links: [],
      proofLinks: [],
    };
  }

  const runner = options.runner;
  if (!runner) {
    return {
      ok: false,
      source: 'x-profile',
      ...parsed,
      error: 'xurl profile runner unavailable',
      objections: [],
      marketSignals: [],
      socialSignals: [],
      recentPosts: [],
      links: [],
      proofLinks: [],
      detailLines: [`I saw the profile URL ${parsed.url}, but live X profile collection is unavailable.`],
    };
  }

  try {
    const payload = await runner(parsed.handle, { maxPosts: options.maxPosts || 12 });
    const normalized = normalizeProfilePayload(payload, parsed.handle);
    const bio = normalized.profile.bio || '';
    const pinnedPost = normalized.pinnedPost || null;
    const recentPosts = normalized.recentPosts.slice(0, options.maxPosts || 12);
    const postingCadence = derivePostingCadence(recentPosts);
    const repeatedNarrative = deriveRepeatedNarrative({ bio, pinnedPost, recentPosts });
    const links = unique([
      ...extractLinksFromProfile(normalized.profile),
      ...collectTweetLinks([pinnedPost, ...recentPosts]),
    ]).slice(0, 12);
    const proofLinks = links.filter(isProofLink).slice(0, 8);
    const engagementSignals = summarizeEngagement(recentPosts, pinnedPost);
    const textCorpus = buildCorpus({ bio, pinnedPost, recentPosts, repeatedNarrative });
    const objections = extractObjections(textCorpus, repeatedNarrative, proofLinks);
    const marketSignals = extractMarketSignals(textCorpus, postingCadence, engagementSignals, repeatedNarrative);
    const socialSignals = extractSocialSignals(normalized.profile, pinnedPost, postingCadence, repeatedNarrative);
    const detailLines = buildDetailLines({ normalized, postingCadence, repeatedNarrative, proofLinks, engagementSignals });

    return {
      ok: true,
      source: 'x-profile',
      ...parsed,
      profile: normalized.profile,
      bio,
      pinnedPost,
      recentPosts,
      links,
      proofLinks,
      postingCadence,
      repeatedNarrative,
      engagementSignals,
      objections,
      marketSignals,
      socialSignals,
      detailLines,
    };
  } catch (error) {
    return {
      ok: false,
      source: 'x-profile',
      ...parsed,
      error: error.message,
      objections: [],
      marketSignals: [],
      socialSignals: [],
      recentPosts: [],
      links: [],
      proofLinks: [],
      detailLines: [`I saw the profile URL ${parsed.url}, but the collector failed: ${error.message}`],
    };
  }
}

function parseXProfileUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (!isXProfileUrl(url.toString())) return null;
    const handle = url.pathname.split('/').filter(Boolean)[0]?.replace(/^@/, '') || '';
    return {
      url: `https://x.com/${handle}`,
      handle,
    };
  } catch {
    return null;
  }
}

function normalizeProfilePayload(payload, handle) {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const profileRaw = parsed?.profile || parsed?.user || parsed?.data || parsed?.account || {};
  const profile = normalizeProfile(profileRaw, handle);
  const pinnedPost = normalizeTweet(parsed?.pinnedPost || parsed?.pinned || parsed?.pin || null);
  const recentPosts = normalizeTweetList(parsed?.recentPosts || parsed?.posts || parsed?.tweets || parsed?.timeline || parsed?.data?.posts || []);
  return { profile, pinnedPost, recentPosts };
}

function normalizeProfile(profile, fallbackHandle) {
  const metrics = profile?.public_metrics || profile?.publicMetrics || {};
  const entities = profile?.entities || {};
  return {
    id: stringify(profile?.id),
    username: stringify(profile?.username || profile?.screen_name || fallbackHandle),
    name: stringify(profile?.name),
    bio: stringify(profile?.description || profile?.bio),
    createdAt: stringify(profile?.created_at || profile?.createdAt),
    verified: Boolean(profile?.verified || profile?.verified_type || profile?.verifiedType),
    verifiedType: stringify(profile?.verified_type || profile?.verifiedType),
    followers: toNumber(metrics.followers_count ?? metrics.followersCount),
    following: toNumber(metrics.following_count ?? metrics.followingCount),
    tweetCount: toNumber(metrics.tweet_count ?? metrics.tweetCount),
    listedCount: toNumber(metrics.listed_count ?? metrics.listedCount),
    url: stringify(profile?.url),
    entities,
  };
}

function normalizeTweetList(input) {
  const rows = Array.isArray(input)
    ? input
    : Array.isArray(input?.data)
      ? input.data
      : [];
  return rows.map(normalizeTweet).filter((tweet) => tweet && tweet.text);
}

function normalizeTweet(tweet) {
  if (!tweet) return null;
  const metrics = tweet.public_metrics || tweet.publicMetrics || tweet.metrics || {};
  return {
    id: stringify(tweet.id),
    text: stringify(tweet.text || tweet.full_text || tweet.fullText || tweet.content),
    createdAt: stringify(tweet.created_at || tweet.createdAt),
    lang: stringify(tweet.lang),
    likeCount: toNumber(metrics.like_count ?? metrics.likes ?? tweet.like_count ?? tweet.favorite_count),
    replyCount: toNumber(metrics.reply_count ?? metrics.replies ?? tweet.reply_count),
    repostCount: toNumber(metrics.retweet_count ?? metrics.repost_count ?? metrics.retweets ?? tweet.retweet_count),
    quoteCount: toNumber(metrics.quote_count ?? metrics.quotes ?? tweet.quote_count),
    bookmarkCount: toNumber(metrics.bookmark_count ?? metrics.bookmarks ?? tweet.bookmark_count),
    impressionCount: toNumber(metrics.impression_count ?? metrics.views ?? tweet.view_count),
    urls: extractUrlsFromTweet(tweet),
  };
}

function extractLinksFromProfile(profile) {
  const urls = [];
  if (profile?.url) urls.push(profile.url);
  for (const item of profile?.entities?.url?.urls || []) {
    urls.push(item.expanded_url || item.expandedUrl || item.url);
  }
  for (const item of profile?.entities?.description?.urls || []) {
    urls.push(item.expanded_url || item.expandedUrl || item.url);
  }
  return urls.map(cleanUrl).filter(Boolean);
}

function extractUrlsFromTweet(tweet) {
  const urls = [];
  for (const item of tweet?.entities?.urls || tweet?.attachments?.urls || []) {
    urls.push(item.expanded_url || item.expandedUrl || item.url);
  }
  if (tweet?.text) {
    for (const match of String(tweet.text).matchAll(/https?:\/\/\S+/g)) {
      urls.push(match[0]);
    }
  }
  return unique(urls.map(cleanUrl).filter(Boolean));
}

function collectTweetLinks(tweets) {
  return tweets.flatMap((tweet) => tweet?.urls || []);
}

function derivePostingCadence(posts) {
  const dated = posts
    .map((post) => ({ ...post, ts: Date.parse(post.createdAt || '') }))
    .filter((post) => Number.isFinite(post.ts))
    .sort((a, b) => b.ts - a.ts);
  if (dated.length < 2) {
    return {
      label: dated.length === 1 ? 'single recent sample only' : 'cadence unavailable',
      postsObserved: dated.length,
      avgHoursBetweenPosts: null,
      daysCovered: null,
    };
  }
  const deltas = [];
  for (let i = 1; i < dated.length; i += 1) deltas.push((dated[i - 1].ts - dated[i].ts) / 36e5);
  const avgHours = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
  const daysCovered = Math.max(0.1, (dated[0].ts - dated.at(-1).ts) / 864e5);
  let label = 'occasional posting';
  if (avgHours <= 8) label = 'multiple posts per day';
  else if (avgHours <= 30) label = 'roughly daily posting';
  else if (avgHours <= 96) label = 'every few days';
  else if (avgHours <= 240) label = 'roughly weekly posting';
  else label = 'sporadic posting';
  return {
    label,
    postsObserved: dated.length,
    avgHoursBetweenPosts: Number(avgHours.toFixed(1)),
    daysCovered: Number(daysCovered.toFixed(1)),
  };
}

function deriveRepeatedNarrative({ bio, pinnedPost, recentPosts }) {
  const pool = [bio, pinnedPost?.text, ...recentPosts.map((post) => post.text)].filter(Boolean).join(' ');
  const tokens = pool
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9$#@\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !STOPWORDS.has(token));
  const singleCounts = countPhrases(tokens.map((token) => [token]));
  const bigramCounts = countPhrases(tokens.slice(0, -1).map((token, index) => [token, tokens[index + 1]]));
  const phrases = [...bigramCounts, ...singleCounts]
    .filter((item) => item.count >= 2)
    .sort((a, b) => b.count - a.count || b.phrase.length - a.phrase.length)
    .map((item) => item.phrase);
  return unique(phrases).slice(0, 4);
}

function countPhrases(groups) {
  const map = new Map();
  for (const group of groups) {
    const phrase = group.join(' ').trim();
    if (!phrase || phrase.length < 4) continue;
    map.set(phrase, (map.get(phrase) || 0) + 1);
  }
  return [...map.entries()].map(([phrase, count]) => ({ phrase, count }));
}

function summarizeEngagement(posts, pinnedPost) {
  const rows = [pinnedPost, ...posts].filter(Boolean);
  if (!rows.length) return { label: 'engagement unavailable', avgLikes: null, avgReplies: null, standout: null };
  const sum = rows.reduce((acc, post) => {
    acc.likes += post.likeCount || 0;
    acc.replies += post.replyCount || 0;
    acc.reposts += post.repostCount || 0;
    acc.impressions += post.impressionCount || 0;
    return acc;
  }, { likes: 0, replies: 0, reposts: 0, impressions: 0 });
  const standout = rows.slice().sort((a, b) => engagementScore(b) - engagementScore(a))[0] || null;
  const avgLikes = Number((sum.likes / rows.length).toFixed(1));
  const avgReplies = Number((sum.replies / rows.length).toFixed(1));
  const avgReposts = Number((sum.reposts / rows.length).toFixed(1));
  const label = avgLikes >= 200 || avgReplies >= 20
    ? 'strong public pickup'
    : avgLikes >= 40 || avgReplies >= 5
      ? 'some visible engagement'
      : 'low visible engagement';
  return {
    label,
    avgLikes,
    avgReplies,
    avgReposts,
    avgImpressions: rows.some((post) => post.impressionCount != null) ? Number((sum.impressions / rows.length).toFixed(1)) : null,
    standout: standout ? summarizeTweet(standout) : null,
  };
}

function buildCorpus({ bio, pinnedPost, recentPosts, repeatedNarrative }) {
  return [bio, pinnedPost?.text, ...recentPosts.map((post) => post.text), ...repeatedNarrative]
    .filter(Boolean)
    .join('\n');
}

function extractObjections(text, repeatedNarrative, proofLinks) {
  const lines = splitLines(text);
  const objections = lines.filter((line) => /proof|demo|alpha|waitlist|soon|roadmap|token|utility|holders?|liquidity|scam|exit|farm|trust|docs|github|ship|building/i.test(line));
  if (!proofLinks.length) objections.push('profile talks, but proof links are missing or hard to verify from the profile itself');
  if (!repeatedNarrative.length) objections.push('narrative is hard to compress because no repeated thesis stands out across the bio and recent posts');
  return unique(objections).slice(0, 8);
}

function extractMarketSignals(text, postingCadence, engagementSignals, repeatedNarrative) {
  const out = splitLines(text).filter((line) => /base|token|market|holders?|liquidity|launch|buy|sell|volume|attention|distribution|community|product|demo|ship/i.test(line));
  if (postingCadence?.label) out.push(`posting cadence: ${postingCadence.label}`);
  if (engagementSignals?.label) out.push(`engagement read: ${engagementSignals.label}`);
  if (repeatedNarrative.length) out.push(`repeated narrative: ${repeatedNarrative.join(' / ')}`);
  if (engagementSignals?.standout) out.push(`standout post: ${engagementSignals.standout}`);
  return unique(out).slice(0, 10);
}

function extractSocialSignals(profile, pinnedPost, postingCadence, repeatedNarrative) {
  const out = [];
  if (profile?.bio) out.push(`bio thesis: ${profile.bio}`);
  if (pinnedPost?.text) out.push(`pinned post frames the account as: ${trimText(pinnedPost.text, 180)}`);
  if (postingCadence?.label) out.push(`account posts with ${postingCadence.label}`);
  if (repeatedNarrative.length) out.push(`account keeps repeating: ${repeatedNarrative.join(' / ')}`);
  if (profile?.followers != null) out.push(`visible follower count: ${profile.followers}`);
  return unique(out).slice(0, 10);
}

function buildDetailLines({ normalized, postingCadence, repeatedNarrative, proofLinks, engagementSignals }) {
  const { profile, pinnedPost, recentPosts } = normalized;
  return [
    profile?.bio ? `Bio: ${trimText(profile.bio, 180)}` : '',
    pinnedPost?.text ? `Pinned: ${trimText(pinnedPost.text, 180)}` : '',
    postingCadence?.label ? `Cadence: ${postingCadence.label}${postingCadence.avgHoursBetweenPosts != null ? ` · avg ${postingCadence.avgHoursBetweenPosts}h between recent posts` : ''}` : '',
    repeatedNarrative.length ? `Repeated narrative: ${repeatedNarrative.join(' / ')}` : '',
    proofLinks.length ? `Proof links: ${proofLinks.slice(0, 3).join(' · ')}` : 'Proof links: none obvious from bio/pinned/recent posts',
    engagementSignals?.label ? `Engagement: ${engagementSignals.label}${engagementSignals.avgLikes != null ? ` · avg ${engagementSignals.avgLikes} likes / ${engagementSignals.avgReplies} replies` : ''}` : '',
    recentPosts.length ? `Recent posts sampled: ${recentPosts.length}` : '',
  ].filter(Boolean).slice(0, 7);
}

function summarizeTweet(tweet) {
  const stats = [`${tweet.likeCount || 0} likes`, `${tweet.replyCount || 0} replies`, `${tweet.repostCount || 0} reposts`].join(', ');
  return `${trimText(tweet.text, 110)} (${stats})`;
}

function engagementScore(tweet) {
  return (tweet.likeCount || 0) + (tweet.replyCount || 0) * 3 + (tweet.repostCount || 0) * 2 + (tweet.impressionCount || 0) / 100;
}

function isProofLink(url) {
  return /github|gitbook|docs|mirror|substack|dune|etherscan|basescan|app\.|demo|notion|figma|discord|telegram|whitepaper|deck/i.test(url || '');
}

function splitLines(text) {
  return String(text || '')
    .split(/\n|(?<=[.!?])\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function trimText(text, max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function cleanUrl(url) {
  if (!url) return '';
  return String(url).replace(/[),.;]+$/, '').trim();
}

function unique(items) {
  const seen = new Set();
  const out = [];
  for (const item of items.filter(Boolean)) {
    const key = String(item).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function stringify(value) {
  return value == null ? '' : String(value).trim();
}

function toNumber(value) {
  return value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
}
