import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

type FeedItem = {
  id: string;
  date: string; // YYYY-MM-DD
  text: string;
  place?: string;
  generated_at?: string; // ISO string (often Z)
  image?: string; // local path or absolute URL
  image_prompt?: string; // optional (for matching)
};

type AdItem = {
  kind: "ad";
  id: string;
  title: string;
  body: string;
  cta?: string;
  url?: string;
  sponsor?: string;
  disclaimer?: string;
  emoji?: string;
};

type TimelineItem = FeedItem | AdItem;

function isAdItem(it: TimelineItem): it is AdItem {
  return (it as any)?.kind === "ad";
}

type Feed = {
  updated_at?: string;
  place?: string;
  items: FeedItem[];
};

const APP_BG = "#f6f4ff";
const CARD_BG = "#ffffff";
const TEXT_DIM = "#333333";

const BORDER = "#000000";
const BUBBLE_RADIUS = 16;
const BUBBLE_BORDER_W = 2;

const CONTENT_MAX_W = 760;
const MASCOT_COL_W = 128;
const MASCOT_SIZE = 96;
const MASCOT_RADIUS = 12;
const MASCOT_BORDER_W = 2;
const SIDEBAR_W = 240;

const FEED_SCROLL_ID = "feed-scroll";

const AD_EVERY_N = 5; // 1 ad per 5 timeline items (i.e., after 4 posts)

const AD_BG = "#fff7ed"; // light amber
const AD_BADGE_BG = "#fb923c";

const FAKE_AD_TEMPLATES: Omit<AdItem, "id" | "kind">[] = [
  {
    title: "Miura Peninsula Weekend Pass",
    body: "Ride, hike, and snack your way around the coast. One pass, zero planning. (Demo ad)",
    cta: "See details",
    url: "https://example.com",
    sponsor: "Coastline Travel Lab",
    disclaimer: "架空の広告（デモ）です。",
    emoji: "🏖️",
  },
  {
    title: "UltraQuiet Fiber for Remote Work",
    body: "Fast line, quiet room, and stable Wi-Fi. Your next “focus day” starts here. (Demo ad)",
    cta: "Check availability",
    url: "https://example.com",
    sponsor: "QuietHome",
    disclaimer: "架空の広告（デモ）です。",
    emoji: "🛜",
  },
  {
    title: "Sunset Photo Walk",
    body: "A 60-minute photo stroll + friendly meetup. Bring your phone, leave with memories. (Demo ad)",
    cta: "Join a session",
    url: "https://example.com",
    sponsor: "Yokosuka Photo Club",
    disclaimer: "架空の広告（デモ）です。",
    emoji: "📷",
  },
  {
    title: "Local Curry Stamp Rally",
    body: "Collect stamps at local curry spots and get a small reward. New flavors every week. (Demo ad)",
    cta: "Start collecting",
    url: "https://example.com",
    sponsor: "Curry & Co.",
    disclaimer: "架空の広告（デモ）です。",
    emoji: "🍛",
  },
  {
    title: "Morning Run + Coffee Combo",
    body: "Finish your run, show your tracking screen, and get a runner’s discount. (Demo ad)",
    cta: "Find a cafe",
    url: "https://example.com",
    sponsor: "Runner’s Brew",
    disclaimer: "架空の広告（デモ）です。",
    emoji: "🏃‍♂️",
  },
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function makeAdForAnchor(anchorId: string): AdItem {
  const idx = hashString(anchorId) % FAKE_AD_TEMPLATES.length;
  const t = FAKE_AD_TEMPLATES[idx];
  return {
    kind: "ad",
    id: `ad|${anchorId}`,
    ...t,
  };
}

function interleaveAds(posts: FeedItem[]): TimelineItem[] {
  // After every 4 posts, insert 1 ad => ads become ~20% (= 1 per 5 items).
  const out: TimelineItem[] = [];
  const afterPosts = Math.max(1, AD_EVERY_N - 1);

  let count = 0;
  for (const p of posts) {
    out.push(p);
    count += 1;

    if (count % afterPosts === 0) {
      out.push(makeAdForAnchor(p.id));
    }
  }
  return out;
}

function ensureWebScrollbarStyle() {
  if (Platform.OS !== "web") return;

  const STYLE_ID = "hide-scrollbar-style";
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Hide scrollbars (but keep scrolling) */
    #${FEED_SCROLL_ID} {
      scrollbar-width: none; /* Firefox */
      -ms-overflow-style: none; /* IE/Edge */
    }
    #${FEED_SCROLL_ID}::-webkit-scrollbar {
      display: none; /* Chrome/Safari */
    }
  `;
  document.head.appendChild(style);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function resolveUrl(pathOrUrl: string, baseUrl: string): string {
  try {
    return new URL(pathOrUrl, baseUrl).toString();
  } catch {
    return pathOrUrl;
  }
}

function addCacheBuster(url: string): string {
  const u = String(url ?? "");
  if (!u) return u;
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}_=${Date.now()}`;
}

function formatJst(iso: string, withTime?: boolean): string {
  try {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    const yy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return withTime ? `${yy}-${mm}-${dd} ${hh}:${mi}` : `${yy}-${mm}-${dd}`;
  } catch {
    return iso;
  }
}

/**
 * Normalize various feed shapes into:
 * { updated_at, place, items: [{id,date,text,place,generated_at,image,image_prompt}] }
 */
function normalizeFeed(parsed: unknown): Feed | null {
  if (!parsed) return null;

  if (typeof parsed === "object" && parsed !== null) {
    const obj: any = parsed as any;

    // shape: { items: [...] }
    if (Array.isArray(obj.items)) {
      const items: FeedItem[] = obj.items
        .map((it: any, idx: number): FeedItem | null => {
          const date = typeof it?.date === "string" ? it.date : "";
          const text = typeof it?.text === "string" ? it.text : "";
          if (!date || !text) return null;
          const id = typeof it?.id === "string" ? it.id : `${date}-${idx}`;
          const place = typeof it?.place === "string" ? it.place : undefined;
          const generated_at = typeof it?.generated_at === "string" ? it.generated_at : undefined;
          const image =
            typeof it?.image === "string"
              ? it.image
              : typeof it?.image_url === "string"
              ? it.image_url
              : typeof it?.imageUri === "string"
              ? it.imageUri
              : undefined;
          const image_prompt = typeof it?.image_prompt === "string" ? it.image_prompt : undefined;
          return { id, date, text, place, generated_at, image, image_prompt };
        })
        .filter(Boolean) as FeedItem[];

      return {
        updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined,
        place: typeof obj.place === "string" ? obj.place : undefined,
        items,
      };
    }

    // shape: { date, text }
    const date = typeof obj.date === "string" ? obj.date : "";
    const text = typeof obj.text === "string" ? obj.text : "";
    if (date && text) {
      const id = typeof obj.id === "string" ? obj.id : `${date}-0`;
      const place = typeof obj.place === "string" ? obj.place : undefined;
      const generated_at = typeof obj.generated_at === "string" ? obj.generated_at : undefined;
      const image =
        typeof obj?.image === "string"
          ? obj.image
          : typeof obj?.image_url === "string"
          ? obj.image_url
          : typeof obj?.imageUri === "string"
          ? obj.imageUri
          : undefined;
      const image_prompt = typeof obj?.image_prompt === "string" ? obj.image_prompt : undefined;
      const updated_at = generated_at;
      return { updated_at, place, items: [{ id, date, text, place, generated_at, image, image_prompt }] };
    }
  }

  if (Array.isArray(parsed)) {
    const items: FeedItem[] = parsed
      .map((it: any, idx: number): FeedItem | null => {
        const date = typeof it?.date === "string" ? it.date : "";
        const text = typeof it?.text === "string" ? it.text : "";
        if (!date || !text) return null;
        const id = typeof it?.id === "string" ? it.id : `${date}-${idx}`;
        const place = typeof it?.place === "string" ? it.place : undefined;
        const generated_at = typeof it?.generated_at === "string" ? it.generated_at : undefined;
        const image =
          typeof it?.image === "string"
            ? it.image
            : typeof it?.image_url === "string"
            ? it.image_url
            : typeof it?.imageUri === "string"
            ? it.imageUri
            : undefined;
        const image_prompt = typeof it?.image_prompt === "string" ? it.image_prompt : undefined;
        return { id, date, text, place, generated_at, image, image_prompt };
      })
      .filter(Boolean) as FeedItem[];

    const last = parsed.length > 0 ? (parsed[parsed.length - 1] as any) : null;
    const updated_at = typeof last?.generated_at === "string" ? last.generated_at : undefined;
    const place = typeof last?.place === "string" ? last.place : undefined;

    return { updated_at, place, items };
  }

  return null;
}

type ShareSdItem = {
  date?: string;
  place?: string;
  image: string;
  prompt?: string;
};

type ShareSdIndex = {
  updated_at?: string;
  items: ShareSdItem[];
};

function normalizeWebAssetPath(p: string): string {
  let s = String(p ?? "").trim();
  if (!s) return "";
  if (/^(https?:)?\/\//i.test(s) || s.startsWith("data:")) return s;
  if (!s.startsWith("/")) s = `/${s}`;
  return s;
}

function buildSharePrompt(text: string, place?: string): string {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  const p = String(place ?? "").trim();
  return p ? `${t} (${p})` : t;
}

function normalizeShareSdIndex(parsed: unknown): ShareSdIndex | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj: any = parsed as any;
  const items: ShareSdItem[] = Array.isArray(obj.items)
    ? obj.items
        .map((it: any): ShareSdItem | null => {
          const image = typeof it?.image === "string" ? it.image : "";
          if (!image) return null;
          const date = typeof it?.date === "string" ? it.date : undefined;
          const place = typeof it?.place === "string" ? it.place : undefined;
          const prompt = typeof it?.prompt === "string" ? it.prompt : undefined;
          return { image, date, place, prompt };
        })
        .filter(Boolean) as ShareSdItem[]
    : [];

  return {
    updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined,
    items,
  };
}

// ✅ Allow override by ENV, fallback to public/feed/latest.json
const RESOLVED_FEED_URL =
  (process.env.EXPO_PUBLIC_FEED_URL ?? process.env.EXPO_PUBLIC_FEED_JSON_URL ?? "").trim() || "/feed/latest.json";

// ✅ Optional: share_sd index for prompt->image mapping
const SHARE_SD_INDEX_URL = (process.env.EXPO_PUBLIC_SHARE_SD_INDEX_URL ?? "").trim();

// ✅ Optional: show sidebars on large web view
const SHOW_SIDEBARS_DEFAULT = (process.env.EXPO_PUBLIC_SHOW_SIDEBARS ?? "").trim().toLowerCase() !== "false";

function Mascot({ size = MASCOT_SIZE }: { size?: number }) {
  const [failed, setFailed] = useState(false);
  const envUri = (process.env.EXPO_PUBLIC_MASCOT_URI || "").trim();

  const resolvedEnvUri = useMemo(() => {
    if (!envUri) return "";
    // Only use the env URI when it is clearly an absolute URL/data URI.
    // (Relative strings like "avatar.png" often cause 404s on GitHub Pages.)
    if (/^(https?:)?\/\//i.test(envUri) || envUri.startsWith("data:")) return envUri;
    return "";
  }, [envUri]);

  const Frame = ({ children }: { children: React.ReactNode }) => (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: MASCOT_RADIUS,
        borderWidth: MASCOT_BORDER_W,
        borderColor: BORDER,
        overflow: "hidden",
        backgroundColor: "#ffffff",
      }}
      accessibilityLabel="Mascot"
    >
      {children}
    </View>
  );

  if (!failed && resolvedEnvUri) {
    return (
      <Frame>
        <Image
          source={{ uri: resolvedEnvUri }}
          style={{ width: "100%", height: "100%" }}
          accessibilityLabel="Mascot"
          onError={() => setFailed(true)}
        />
      </Frame>
    );
  }

  try {
    const fallback = require("../assets/images/avatar.png");
    return (
      <Frame>
        <Image source={fallback} style={{ width: "100%", height: "100%" }} accessibilityLabel="Mascot" />
      </Frame>
    );
  } catch {
    // ignore
  }

  return (
    <Frame>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#111111" }}>
        <Text style={{ color: "#ffffff", fontWeight: "512", fontSize: Math.max(18, Math.floor(size * 0.35)) }}>R</Text>
      </View>
    </Frame>
  );
}

function FeedBubbleImage({ uris }: { uris: string[] }) {
  const [bad, setBad] = useState<Record<string, boolean>>({});

  const goodUris = useMemo(() => uris.filter((u) => u && !bad[u]), [uris, bad]);

  if (goodUris.length === 0) return null;

  return (
    <View style={{ marginTop: 10, gap: 10 }}>
      {goodUris.map((u) => (
        <Image
          key={u}
          source={{ uri: u }}
          style={{
            width: "100%",
            aspectRatio: 4 / 3,
            borderRadius: 12,
            borderWidth: 2,
            borderColor: BORDER,
            backgroundColor: "#ffffff",
          }}
          resizeMode="cover"
          onError={() => setBad((prev) => ({ ...prev, [u]: true }))}
        />
      ))}
    </View>
  );
}

function Slot() {
  const enabled = process.env.EXPO_PUBLIC_USE_SLOT === "1";
  if (!enabled) return null;

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: APP_BG,
        borderWidth: 1,
        borderColor: BORDER,
        borderRadius: 12,
        padding: 12,
      }}
    >
      <Text style={{ color: TEXT_DIM, marginTop: 6, lineHeight: 18 }}>
      </Text>
    </View>
  );
}

export default function HomeScreen() {
  const { width } = useWindowDimensions();

  const showSidebars = Platform.OS === "web" && SHOW_SIDEBARS_DEFAULT && width >= 1100;

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [feed, setFeed] = useState<Feed | null>(null);
  const [nextUrl, setNextUrl] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const [shareSdIndex, setShareSdIndex] = useState<ShareSdIndex | null>(null);

  useEffect(() => {
    ensureWebScrollbarStyle();
  }, []);

  const fetchJson = useCallback(async (url: string): Promise<{ raw: string; parsed: unknown }> => {
    const finalUrl = addCacheBuster(url);
    const res = await fetch(finalUrl, { headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.text();
    const parsed = safeJsonParse(raw);
    return { raw, parsed };
  }, []);

  const sortedItems = useMemo(() => {
    const items = feed?.items ?? [];
    return [...items].sort((a, b) => {
      const ta = (a.generated_at || a.date || "").toString();
      const tb = (b.generated_at || b.date || "").toString();
      return ta < tb ? 1 : ta > tb ? -1 : 0;
    });
  }, [feed]);

  const timelineItems = useMemo(() => interleaveAds(sortedItems), [sortedItems]);

  const [effectiveUrl, setEffectiveUrl] = useState<string>(RESOLVED_FEED_URL);

  useEffect(() => {
    if (!SHARE_SD_INDEX_URL) return;

    let cancelled = false;

    (async () => {
      try {
        const base =
          Platform.OS === "web" && typeof window !== "undefined" ? window.location.href : RESOLVED_FEED_URL;

        const resolved = resolveUrl(normalizeWebAssetPath(SHARE_SD_INDEX_URL), base);
        const target = await fetchJson(resolved);
        const normalized = normalizeShareSdIndex(target.parsed);

        if (!cancelled) {
          setShareSdIndex(normalized);
        }
      } catch {
        // ignore (images are optional)
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [SHARE_SD_INDEX_URL, RESOLVED_FEED_URL, fetchJson]);

  const sharePromptToImage = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of shareSdIndex?.items ?? []) {
      if (it.prompt && it.image) {
        m.set(it.prompt, it.image);
        continue;
      }
      if (it.date && it.place && it.image) {
        m.set(`${it.date}|${it.place}`, it.image);
      }
    }
    return m;
  }, [shareSdIndex]);

  const assetBase = useMemo(() => {
    if (Platform.OS === "web" && typeof window !== "undefined") return window.location.href;
    return effectiveUrl || RESOLVED_FEED_URL;
  }, [effectiveUrl, RESOLVED_FEED_URL]);

  const getImageUrisForItem = useCallback(
    (item: FeedItem): string[] => {
      const uris: string[] = [];

      const push = (p?: string) => {
        const s = String(p ?? "").trim();
        if (!s) return;
        const resolved = resolveUrl(normalizeWebAssetPath(s), assetBase);
        if (!uris.includes(resolved)) uris.push(resolved);
      };

      // 1) Direct field (best)
      if (item.image) push(item.image);

      // 2) Stem-match rule: if id looks like feed stem, try /image/<id>.png
      const id = String(item.id ?? "").trim();
      if (id && id.startsWith("feed_")) {
        push(`/image/${encodeURIComponent(id)}.png`);
      }

      // 3) Optional: share_sd index match (if configured)
      const place = item.place || feed?.place;
      const prompt = item.image_prompt || buildSharePrompt(item.text, place);

      const fromPrompt = sharePromptToImage.get(prompt);
      if (fromPrompt) push(fromPrompt);

      return uris;
    },
    [assetBase, feed, sharePromptToImage]
  );

  const loadInitial = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const base =
        Platform.OS === "web" && typeof window !== "undefined" ? window.location.href : RESOLVED_FEED_URL;

      const resolved = resolveUrl(normalizeWebAssetPath(RESOLVED_FEED_URL), base);
      setEffectiveUrl(resolved);

      const target = await fetchJson(resolved);

      // latest.json might be:
      // 1) { url: "feed/page_000.json" }
      // 2) direct feed object
      // 3) array
      // We'll normalize everything.

      let next: string | null = null;
      let feedObj: Feed | null = null;

      if (target.parsed && typeof target.parsed === "object" && !Array.isArray(target.parsed)) {
        const obj: any = target.parsed as any;

        if (typeof obj.url === "string") {
          const pageUrl = resolveUrl(normalizeWebAssetPath(obj.url), resolved);
          const pageRes = await fetchJson(pageUrl);

          // page shape: { items, next }
          if (pageRes.parsed && typeof pageRes.parsed === "object" && !Array.isArray(pageRes.parsed)) {
            const pageObj: any = pageRes.parsed as any;
            next = typeof pageObj.next === "string" ? resolveUrl(normalizeWebAssetPath(pageObj.next), pageUrl) : null;
          }

          feedObj = normalizeFeed(pageRes.parsed);
        } else {
          // maybe it's already a page with next?
          next = typeof obj.next === "string" ? resolveUrl(normalizeWebAssetPath(obj.next), resolved) : null;
          feedObj = normalizeFeed(obj);
        }
      } else {
        // array or other
        feedObj = normalizeFeed(target.parsed);
      }

      setFeed(feedObj);
      setNextUrl(next);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
      setFeed(null);
      setNextUrl(null);
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    void loadInitial();
  }, [loadInitial]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadInitial();
    } finally {
      setRefreshing(false);
    }
  }, [loadInitial]);

  const loadMore = useCallback(async () => {
    if (!nextUrl || loadingMore) return;

    setLoadingMore(true);
    setError(null);

    try {
      const target = await fetchJson(nextUrl);

      let normalized = normalizeFeed(target.parsed);

      // page shape could have { next } too
      if (target.parsed && typeof target.parsed === "object" && !Array.isArray(target.parsed)) {
        const obj: any = target.parsed as any;
        const nxt = typeof obj.next === "string" ? resolveUrl(normalizeWebAssetPath(obj.next), nextUrl) : null;
        setNextUrl(nxt);
      } else {
        setNextUrl(null);
      }

      if (normalized?.items?.length) {
        setFeed((prev) => {
          const prevItems = prev?.items ?? [];
          const merged: FeedItem[] = [...prevItems];
          const seen = new Set(prevItems.map((it) => it.id));

          for (const it of normalized.items) {
            if (!seen.has(it.id)) {
              merged.push(it);
              seen.add(it.id);
            }
          }

          return {
            updated_at: prev?.updated_at ?? normalized.updated_at,
            place: prev?.place ?? normalized.place,
            items: merged,
          };
        });
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to load more");
    } finally {
      setLoadingMore(false);
    }
  }, [fetchJson, loadingMore, nextUrl]);

  const openFeed = useCallback(() => {
    if (!effectiveUrl) return;
    if (Platform.OS !== "web") return;
    void Linking.openURL(effectiveUrl);
  }, [effectiveUrl]);

  const Header = (
    <View style={{ padding: 16, gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        {feed?.updated_at ? <Text style={{ color: TEXT_DIM }}>Updated At: {formatJst(feed.updated_at, true)}</Text> : null}
      </View>

      {error ? (
        <View
          style={{
            backgroundColor: "#7f1d1d",
            borderRadius: 14,
            padding: 12,
          }}
        >
          <Text style={{ color: "#000000", fontWeight: "800" }}>Error</Text>
          <Text style={{ color: "#000000", marginTop: 6 }}>{error}</Text>
        </View>
      ) : null}
    </View>
  );

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: APP_BG, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10, color: TEXT_DIM }}>Loading…</Text>
      </View>
    );
  }

  const list = (
    <FlatList
      nativeID={FEED_SCROLL_ID}
      showsVerticalScrollIndicator={false}
      style={{ flex: 1, backgroundColor: APP_BG }}
      contentContainerStyle={{ paddingBottom: 18 }}
      data={timelineItems}
      keyExtractor={(it) => it.id}
      ListHeaderComponent={Header}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      onEndReached={loadMore}
      onEndReachedThreshold={0.5}
            ListFooterComponent={
              loadingMore ? (
                <View style={{ padding: 16, alignItems: "center" }}>
                  <ActivityIndicator />
                  <Text style={{ marginTop: 8, color: TEXT_DIM }}>Loading older posts…</Text>
                </View>
              ) : nextUrl ? (
                <View style={{ padding: 16, alignItems: "center" }}>
                  <Text style={{ color: TEXT_DIM }}>Scroll to load older posts…</Text>
                </View>
              ) : (feed?.items?.length ?? 0) > 0 ? (
                <View style={{ padding: 16, alignItems: "center" }}>
                  <Text style={{ color: TEXT_DIM }}>No more posts.</Text>
                </View>
              ) : null
            }
      renderItem={({ item }) => {
        if (isAdItem(item)) {
          const open = () => {
            if (!item.url) return;
            void Linking.openURL(item.url);
          };

          return (
            <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
              <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
                <View style={{ width: MASCOT_COL_W, alignItems: "center" }}>
                  <View style={{ marginTop: 2 }}>
                    <Mascot />
                  </View>
                </View>

                <View style={{ flex: 1 }}>
                  <View style={{ position: "relative", marginTop: 2 }}>
                    <View
                      style={{
                        backgroundColor: AD_BG,
                        padding: 12,
                        borderRadius: BUBBLE_RADIUS,
                        borderWidth: BUBBLE_BORDER_W,
                        borderColor: BORDER,
                        minHeight: MASCOT_SIZE,
                        shadowColor: "#000000",
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.12,
                        shadowRadius: 6,
                        elevation: 2,
                        zIndex: 1,
                      }}
                    >
                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                        <View
                          style={{
                            backgroundColor: AD_BADGE_BG,
                            borderRadius: 999,
                            paddingHorizontal: 8,
                            paddingVertical: 2,
                            borderWidth: 2,
                            borderColor: BORDER,
                          }}
                        >
                          <Text style={{ color: "#000000", fontWeight: "900", fontSize: 12 }}>AD</Text>
                        </View>

                        {item.emoji ? <Text style={{ color: "#000000", fontSize: 14 }}>{item.emoji}</Text> : null}

                        <Text style={{ color: "#000000", fontWeight: "900" }}>{item.title}</Text>

                        {item.sponsor ? <Text style={{ color: TEXT_DIM }}>• {item.sponsor}</Text> : null}
                      </View>

                      <Text style={{ color: "#000000", marginTop: 8, fontSize: 16, lineHeight: 22 }}>{item.body}</Text>

                      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 10 }}>
                        <Pressable
                          onPress={open}
                          disabled={!item.url}
                          style={{
                            backgroundColor: "#ffffff",
                            borderWidth: 2,
                            borderColor: BORDER,
                            borderRadius: 999,
                            paddingHorizontal: 12,
                            paddingVertical: 6,
                            opacity: item.url ? 1 : 0.6,
                          }}
                        >
                          <Text style={{ color: "#000000", fontWeight: "900" }}>{item.cta ?? "Learn more"}</Text>
                        </Pressable>

                        <Text style={{ color: TEXT_DIM, fontSize: 12 }}>{item.disclaimer ?? "架空の広告（デモ）です。"}</Text>
                      </View>
                    </View>

                    <View
                      pointerEvents="none"
                      style={{
                        position: "absolute",
                        left: -7,
                        top: 22,
                        width: 14,
                        height: 14,
                        backgroundColor: AD_BG,
                        transform: [{ rotate: "45deg" }],
                        borderLeftWidth: BUBBLE_BORDER_W,
                        borderBottomWidth: BUBBLE_BORDER_W,
                        borderColor: BORDER,
                        zIndex: 10,
                        elevation: 3,
                      }}
                    />
                  </View>
                </View>
              </View>
            </View>
          );
        }

        const imageUris = getImageUrisForItem(item);
        return (
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
            <View style={{ width: MASCOT_COL_W, alignItems: "center" }}>
              <View style={{ marginTop: 2 }}>
                <Mascot />
              </View>
            </View>

            <View style={{ flex: 1 }}>
              {/* Speech-bubble wrapper */}
              <View style={{ position: "relative", marginTop: 2 }}>
                {/* ✅ 1) Bubble body FIRST */}
                <View
                  style={{
                    backgroundColor: CARD_BG,
                    padding: 12,
                    borderRadius: BUBBLE_RADIUS,
                    borderWidth: BUBBLE_BORDER_W,
                    borderColor: BORDER,
                    minHeight: MASCOT_SIZE,
                    shadowColor: "#000000",
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.12,
                    shadowRadius: 6,
                    elevation: 2,
                    zIndex: 1,
                  }}
                >
                  <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                    {item.generated_at ? <Text style={{ color: TEXT_DIM }}>{formatJst(item.generated_at)}</Text> : null}
                    {item.place ? <Text style={{ color: TEXT_DIM }}>• {item.place}</Text> : null}
                  </View>

                  
<FeedBubbleImage uris={imageUris} />

<Text style={{ color: "#000000", marginTop: 8, fontSize: 16, lineHeight: 22 }}>{item.text}</Text>
                </View>

                {/* ✅ 2) Tail AFTER (on top) to cover the bubble border line */}
                <View
                  pointerEvents="none"
                  style={{
                    position: "absolute",
                    left: -7,
                    top: 22,
                    width: 14,
                    height: 14,
                    backgroundColor: CARD_BG,
                    transform: [{ rotate: "45deg" }],
                    borderLeftWidth: BUBBLE_BORDER_W,
                    borderBottomWidth: BUBBLE_BORDER_W,
                    borderColor: BORDER,
                    zIndex: 10,
                    elevation: 3,
                  }}
                />
              </View>
            </View>
          </View>
        </View>
        );
      }}
      ListEmptyComponent={
        <View style={{ padding: 16 }}>
          <Text style={{ color: TEXT_DIM }}>No posts yet.</Text>
        </View>
      }
    />
  );

  if (!showSidebars) {
    return list;
  }

  return (
    <View style={{ flex: 1, flexDirection: "row", justifyContent: "center", backgroundColor: APP_BG }}>
      <View style={{ width: SIDEBAR_W, paddingTop: 16, paddingLeft: 12, minHeight: 0 }}>
        <Slot />
      </View>

      <View style={{ flex: 1, maxWidth: CONTENT_MAX_W }}>{list}</View>

      <View style={{ width: SIDEBAR_W, paddingTop: 16, paddingRight: 12, minHeight: 0 }}>
        <Slot />
      </View>
    </View>
  );
}
