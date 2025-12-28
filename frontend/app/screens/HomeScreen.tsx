import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Image,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  Text,
  TextInput,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";

type FeedItem = {
  id: string;
  createdAt: string; // ISO string
  place?: string;
  text: string;
  imageUrl?: string; // relative or absolute
  tags?: string[];
};

type AdItem = {
  id: string;
  kind: "ad";
  createdAt: string;
  place?: string;
  title: string;
  detail: string;
  imageUrl?: string;
  ctaLabel?: string;
  ctaUrl?: string;
  tags?: string[];
};

type SlotItem = {
  id: string;
  kind: "slot";
};

type TimelineItem = FeedItem | AdItem | SlotItem;

const APP_BG = "#f6f4ff";
const CARD_BG = "#ffffff";

const TEXT_MAIN = "#0f172a";
const TEXT_DIM = "#475569";

const BORDER = "#111111";
const OUTLINE_W = 1;
const BUBBLE_RADIUS = 18;
const BUBBLE_BORDER_W = OUTLINE_W;

const CONTENT_MAX_W = 780;
const MASCOT_COL_W = 128;
const MASCOT_SIZE = 96;
const MASCOT_RADIUS = 12;
const MASCOT_BORDER_W = OUTLINE_W;
const SIDEBAR_W = 240;

const SURFACE_SHADOW: any =
  Platform.OS === "web"
    ? { boxShadow: "0px 10px 28px rgba(15, 23, 42, 0.12)" }
    : {
        shadowColor: "#000000",
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.12,
        shadowRadius: 14,
        elevation: 3,
      };

const FEED_SCROLL_ID = "feed-scroll";

const ITEM_BG = "#fff7ed";
const ITEM_BADGE_BG = "#000000";
const ITEM_BADGE_FG = "#ffffff";
const SLOT_ROTATE_MS = 5500;

type SlotBanner = {
  id: string;
  label: string; // top left
  title: string;
  subtitle: string;
  buttonLabel?: string;
  buttonKind?: "link" | "play";
  href?: string;
  imageUrl: string;
  footnote?: string;
};

const DEMO_BANNERS: SlotBanner[] = [
  {
    id: "demo-1",
    label: "AD",
    title: "Coffee & quiet time",
    subtitle: "GOODDAY (demo)",
    buttonLabel: "See more",
    buttonKind: "link",
    href: "https://example.com/",
    imageUrl:
      "https://images.unsplash.com/photo-1458668383970-8ddd3927deed?auto=format&fit=crop&w=1200&q=60",
    footnote: "Demo ad slot — not a real promotion.",
  },
  {
    id: "demo-2",
    label: "AD",
    title: "Sunset soundtrack",
    subtitle: "GOODDAY (demo)",
    buttonLabel: "Play",
    buttonKind: "play",
    href: "https://example.com/",
    imageUrl:
      "https://images.unsplash.com/photo-1500375592092-40eb2168fd21?auto=format&fit=crop&w=1200&q=60",
    footnote: "Demo ad slot — not a real promotion.",
  },
  {
    id: "demo-3",
    label: "AD",
    title: "Weekend walk",
    subtitle: "GOODDAY (demo)",
    buttonLabel: "See more",
    buttonKind: "link",
    href: "https://example.com/",
    imageUrl:
      "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=1200&q=60",
    footnote: "Demo ad slot — not a real promotion.",
  },
];

function isAdItem(x: TimelineItem): x is AdItem {
  return (x as any).kind === "ad";
}
function isSlotItem(x: TimelineItem): x is SlotItem {
  return (x as any).kind === "slot";
}

function safeOpenUrl(url?: string) {
  if (!url) return;
  try {
    Linking.openURL(url);
  } catch {
    // ignore
  }
}

function Mascot() {
  const src =
    "https://raw.githubusercontent.com/europanite/rag_chat_bot/main/frontend/assets/mascot.png";

  return (
    <View style={{ alignItems: "center", paddingTop: 10 }}>
      <View
        style={{
          width: MASCOT_SIZE,
          height: MASCOT_SIZE,
          borderRadius: MASCOT_RADIUS,
          borderWidth: MASCOT_BORDER_W,
          borderColor: BORDER,
          backgroundColor: CARD_BG,
          overflow: "hidden",
          ...SURFACE_SHADOW,
        }}
      >
        <Image
          source={{ uri: src }}
          style={{ width: "100%", height: "100%" }}
          resizeMode="cover"
          onError={() => {
            // ignore
          }}
        />
      </View>
    </View>
  );
}

function SlotCard({
  variant,
  banners,
  startIndex = 0,
  sticky,
}: {
  variant: "inline" | "sidebar";
  banners: SlotBanner[];
  startIndex?: number;
  sticky?: boolean;
}) {
  const [idx, setIdx] = useState(startIndex);

  useEffect(() => {
    if (!banners.length) return;
    const t = setInterval(() => {
      setIdx((x) => (x + 1) % banners.length);
    }, SLOT_ROTATE_MS);
    return () => clearInterval(t);
  }, [banners.length]);

  const current = banners.length ? banners[idx % banners.length] : null;

  const shellStyle = {
    ...(variant === "sidebar" ? ({ flex: 1 } as const) : ({ width: "100%" } as const)),
    backgroundColor: "transparent",
    borderRadius: 16,
    ...(sticky && Platform.OS === "web" ? ({ position: "sticky", top: 16 } as any) : null),
  };

  const cardStyle = {
    ...(variant === "sidebar" ? ({ flex: 1, minHeight: 0 } as const) : null),
    backgroundColor: CARD_BG,
    borderWidth: OUTLINE_W,
    borderColor: BORDER,
    borderRadius: 16,
    overflow: "hidden",
    ...SURFACE_SHADOW,
  };

  const imgStyle = {
    width: "100%",
    height: variant === "sidebar" ? "100%" : 240,
    flex: variant === "sidebar" ? 1 : undefined,
  } as const;

  const overlayStyle = {
    position: "absolute" as const,
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderTopWidth: OUTLINE_W,
    borderTopColor: BORDER,
  };

  const badgeStyle = {
    position: "absolute" as const,
    left: 10,
    top: 10,
    backgroundColor: "#000",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  };

  const dotsWrapStyle = {
    position: "absolute" as const,
    bottom: 10,
    left: 0,
    right: 0,
    alignItems: "center" as const,
  };

  const dotsStyle = {
    flexDirection: "row" as const,
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.65)",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: OUTLINE_W,
    borderColor: "rgba(0,0,0,0.25)",
  };

  const dot = (active: boolean) => ({
    width: 8,
    height: 8,
    borderRadius: 99,
    backgroundColor: active ? "rgba(0,0,0,0.95)" : "rgba(0,0,0,0.25)",
  });

  if (!current) {
    return (
      <View style={shellStyle}>
        <View style={cardStyle}>
          <View style={{ padding: 14 }}>
            <Text style={{ color: TEXT_DIM }}>No demo banner</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={shellStyle}>
      <View style={cardStyle}>
        <Pressable
          onPress={() => safeOpenUrl(current.href)}
          style={{ flex: 1 }}
        >
          <Image source={{ uri: current.imageUrl }} style={imgStyle} resizeMode="cover" />

          <View style={badgeStyle}>
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 12 }}>{current.label}</Text>
          </View>

          {variant === "inline" ? (
            <View style={overlayStyle}>
              <Text style={{ color: TEXT_DIM, fontSize: 12 }}>{current.subtitle}</Text>
              <Text style={{ color: TEXT_MAIN, fontWeight: "800", fontSize: 18, marginTop: 2 }}>
                {current.title}
              </Text>

              {!!current.buttonLabel && (
                <View
                  style={{
                    marginTop: 10,
                    alignSelf: "flex-start",
                    paddingVertical: 8,
                    paddingHorizontal: 12,
                    borderWidth: OUTLINE_W,
                    borderColor: BORDER,
                    borderRadius: 999,
                    backgroundColor: CARD_BG,
                  }}
                >
                  <Text style={{ fontWeight: "800" }}>{current.buttonLabel}</Text>
                </View>
              )}

              {!!current.footnote && (
                <Text style={{ color: "rgba(0,0,0,0.55)", fontSize: 12, marginTop: 10 }}>
                  {current.footnote}
                </Text>
              )}
            </View>
          ) : (
            <View style={{ position: "absolute", left: 12, right: 12, bottom: 12 }}>
              <View
                style={{
                  backgroundColor: "rgba(255,255,255,0.92)",
                  borderWidth: OUTLINE_W,
                  borderColor: BORDER,
                  borderRadius: 16,
                  padding: 12,
                }}
              >
                <Text style={{ color: TEXT_DIM, fontSize: 12 }}>{current.subtitle}</Text>
                <Text style={{ color: TEXT_MAIN, fontWeight: "800", fontSize: 18, marginTop: 2 }}>
                  {current.title}
                </Text>

                {!!current.buttonLabel && (
                  <View
                    style={{
                      marginTop: 10,
                      alignSelf: "flex-start",
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      borderWidth: OUTLINE_W,
                      borderColor: BORDER,
                      borderRadius: 999,
                      backgroundColor: CARD_BG,
                    }}
                  >
                    <Text style={{ fontWeight: "800" }}>{current.buttonLabel}</Text>
                  </View>
                )}

                {!!current.footnote && (
                  <Text style={{ color: "rgba(0,0,0,0.55)", fontSize: 12, marginTop: 10 }}>
                    {current.footnote}
                  </Text>
                )}
              </View>

              <View style={dotsWrapStyle}>
                <View style={dotsStyle}>
                  {banners.map((b, i) => (
                    <View key={b.id} style={dot(i === idx)} />
                  ))}
                </View>
              </View>
            </View>
          )}

          {variant === "inline" && (
            <View style={dotsWrapStyle}>
              <View style={dotsStyle}>
                {banners.map((b, i) => (
                  <View key={b.id} style={dot(i === idx)} />
                ))}
              </View>
            </View>
          )}
        </Pressable>
      </View>
    </View>
  );
}

function Slot({ banners, sticky }: { banners: SlotBanner[]; sticky?: boolean }) {
  return <SlotCard variant="sidebar" banners={banners} sticky={sticky} />;
}

export default function HomeScreen() {
  const { width } = useWindowDimensions();
  const showSidebars = width >= 980;

  const [feed, setFeed] = useState<TimelineItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [query, setQuery] = useState("");
  const [filtered, setFiltered] = useState<TimelineItem[]>([]);

  const listRef = useRef<FlatList<TimelineItem> | null>(null);

  const loadFeed = useCallback(async () => {
    try {
      setLoading(true);
      // You likely fetch local JSON here; keeping the existing behavior.
      // For this exported snapshot, we keep placeholders if fetch fails.
      // Replace with your actual fetch logic.
      const res = await fetch("./feed/latest.json?ts=" + Date.now());
      if (!res.ok) throw new Error("feed fetch failed");
      const data = (await res.json()) as FeedItem[];
      // Example: insert a demo slot every N items + allow ad items
      const timeline: TimelineItem[] = [];
      data.forEach((x, i) => {
        timeline.push(x);
        if (i === 1) timeline.push({ id: "slot-inline-1", kind: "slot" });
      });
      setFeed(timeline);
    } catch {
      // fallback demo
      setFeed([
        {
          id: "demo-feed-1",
          createdAt: new Date().toISOString(),
          place: "Yokosuka",
          text: "Good evening! Winter weather's chill sets in, with a temp of 6°C and cloudy skies. Stay cozy and plan ahead for Dondo-yaki/Otakiage at Iwato 4-chome Park on Jan 11! 🧣❄️ #Yokosuka",
          imageUrl:
            "https://images.unsplash.com/photo-1544986581-efac024faf62?auto=format&fit=crop&w=1200&q=60",
          tags: ["Yokosuka", "winter"],
        },
        { id: "slot-inline-1", kind: "slot" },
        {
          id: "demo-feed-2",
          createdAt: new Date().toISOString(),
          place: "Yokosuka",
          text: "A calm night by the water. If you want a quiet place, try a short walk after dinner.",
          tags: ["night", "walk"],
        },
      ]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  useEffect(() => {
    if (!query.trim()) {
      setFiltered(feed);
      return;
    }
    const q = query.trim().toLowerCase();
    setFiltered(
      feed.filter((x) => {
        if (isSlotItem(x)) return true;
        if (isAdItem(x)) return [x.title, x.detail, x.place, ...(x.tags || [])].join(" ").toLowerCase().includes(q);
        const f = x as FeedItem;
        return [f.text, f.place, ...(f.tags || [])].join(" ").toLowerCase().includes(q);
      })
    );
  }, [query, feed]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFeed();
    setRefreshing(false);
  }, [loadFeed]);

  const renderItem = useCallback(({ item }: { item: TimelineItem }) => {
    if (isSlotItem(item)) {
      return (
        <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
          <SlotCard variant="inline" banners={DEMO_BANNERS} />
        </View>
      );
    }

    if (isAdItem(item)) {
      const bubbleBg = ITEM_BG;
      return (
        <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
          <Pressable onPress={() => safeOpenUrl(item.ctaUrl)} style={{ flexDirection: "row" }}>
            <View style={{ width: MASCOT_COL_W }}>
              <Mascot />
            </View>

            <View style={{ flex: 1, position: "relative" }}>
              <View
                style={{
                  flex: 1,
                  backgroundColor: bubbleBg,
                  borderWidth: BUBBLE_BORDER_W,
                  borderColor: BORDER,
                  borderRadius: BUBBLE_RADIUS,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  ...SURFACE_SHADOW,
                  zIndex: 1,
                }}
              >
                {!!item.imageUrl && (
                  <Image
                    source={{ uri: item.imageUrl }}
                    style={{
                      width: "100%",
                      height: 220,
                      borderRadius: 14,
                      borderWidth: OUTLINE_W,
                      borderColor: "rgba(0,0,0,0.18)",
                      marginBottom: 10,
                    }}
                    resizeMode="cover"
                  />
                )}

                <View
                  style={{
                    alignSelf: "flex-start",
                    backgroundColor: ITEM_BADGE_BG,
                    paddingHorizontal: 10,
                    paddingVertical: 4,
                    borderRadius: 999,
                    marginBottom: 8,
                  }}
                >
                  <Text style={{ color: ITEM_BADGE_FG, fontWeight: "800", fontSize: 12 }}>AD</Text>
                </View>

                <Text style={{ fontSize: 18, fontWeight: "800", color: TEXT_MAIN }}>{item.title}</Text>
                <Text style={{ marginTop: 6, color: TEXT_MAIN, lineHeight: 20 }}>{item.detail}</Text>

                {!!item.ctaLabel && (
                  <View
                    style={{
                      marginTop: 10,
                      alignSelf: "flex-start",
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      borderWidth: OUTLINE_W,
                      borderColor: BORDER,
                      borderRadius: 999,
                      backgroundColor: CARD_BG,
                    }}
                  >
                    <Text style={{ fontWeight: "800", color: TEXT_MAIN }}>{item.ctaLabel}</Text>
                  </View>
                )}
              </View>
            </View>
          </Pressable>
        </View>
      );
    }

    const f = item as FeedItem;

    return (
      <View style={{ paddingHorizontal: 14, paddingVertical: 10 }}>
        <View style={{ flexDirection: "row" }}>
          <View style={{ width: MASCOT_COL_W }}>
            <Mascot />
          </View>

          <View style={{ flex: 1, position: "relative" }}>
            <View
              style={{
                flex: 1,
                backgroundColor: CARD_BG,
                borderWidth: BUBBLE_BORDER_W,
                borderColor: BORDER,
                borderRadius: BUBBLE_RADIUS,
                paddingHorizontal: 14,
                paddingVertical: 12,
                ...SURFACE_SHADOW,
                zIndex: 1,
                gap: 8,
              }}
            >
              <Text style={{ color: TEXT_DIM, fontSize: 12 }}>
                {new Date(f.createdAt).toLocaleString("ja-JP")} {f.place ? ` • ${f.place}` : ""}
              </Text>

              {!!f.imageUrl && (
                <View style={{ borderRadius: 16, overflow: "hidden", borderWidth: OUTLINE_W, borderColor: "rgba(0,0,0,0.18)" }}>
                  <Image source={{ uri: f.imageUrl }} style={{ width: "100%", height: 360 }} resizeMode="cover" />
                </View>
              )}

              <Text style={{ color: TEXT_MAIN, lineHeight: 20 }}>{f.text}</Text>

              {!!f.tags?.length && (
                <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                  {f.tags.map((t) => (
                    <View
                      key={t}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 5,
                        borderWidth: OUTLINE_W,
                        borderColor: "rgba(0,0,0,0.18)",
                        borderRadius: 999,
                        backgroundColor: "rgba(255,255,255,0.9)",
                      }}
                    >
                      <Text style={{ fontSize: 12, color: TEXT_DIM }}>#{t}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>

            {/* Tail AFTER (on top) */}
            <View
              style={{
                position: "absolute",
                left: -7,
                top: 22,
                width: 14,
                height: 14,
                backgroundColor: CARD_BG,
                transform: [{ rotate: "45deg" }],
                borderLeftWidth: BUBBLE_BORDER_W,
                borderTopWidth: BUBBLE_BORDER_W,
                borderColor: BORDER,
                zIndex: 2,
              }}
            />
          </View>
        </View>
      </View>
    );
  }, []);

  const keyExtractor = useCallback((item: TimelineItem) => item.id, []);

  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: APP_BG, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10, color: TEXT_DIM }}>Loading…</Text>
      </View>
    );
  }

  return (
    <View
      style={{
        flex: 1,
        padding: 14,
        backgroundColor: APP_BG,
        flexDirection: "row",
        justifyContent: "center",
        alignItems: "stretch",
      }}
    >
      {showSidebars && (
        <View
          style={{
            width: SIDEBAR_W,
            minHeight: 0,
            marginRight: 14,
          }}
        >
          <Slot banners={DEMO_BANNERS} sticky />
        </View>
      )}

      <View style={{ flex: 1, maxWidth: CONTENT_MAX_W, minWidth: 0 }}>
        <View
          style={{
            backgroundColor: CARD_BG,
            borderWidth: OUTLINE_W,
            borderColor: BORDER,
            borderRadius: 16,
            paddingHorizontal: 12,
            paddingVertical: 10,
            marginBottom: 10,
            ...SURFACE_SHADOW,
          }}
        >
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search…"
            placeholderTextColor="rgba(0,0,0,0.35)"
            style={{
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderWidth: OUTLINE_W,
              borderColor: "rgba(0,0,0,0.18)",
              borderRadius: 12,
              backgroundColor: "rgba(255,255,255,0.95)",
            }}
          />
        </View>

        <FlatList
          ref={(r) => (listRef.current = r)}
          data={filtered}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={{ paddingBottom: 80 }}
          {...(Platform.OS === "web" ? ({ id: FEED_SCROLL_ID } as any) : null)}
        />
      </View>

      {showSidebars && (
        <View
          style={{
            width: SIDEBAR_W,
            minHeight: 0,
            marginLeft: 14,
          }}
        >
          <Slot banners={DEMO_BANNERS} sticky />
        </View>
      )}
    </View>
  );
}
