import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Linking,
  RefreshControl,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

type FeedItem = {
  id: string;
  date: string; // YYYY-MM-DD
  text: string;
  place?: string;
};

type Feed = {
  updated_at?: string;
  place?: string;
  items: FeedItem[];
};

const CARD_BG = "#111827"; // slate-900-ish
const TEXT_DIM = "#9ca3af"; // gray-400

function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function normalizeFeed(parsed: unknown): Feed | null {
  if (!parsed) return null;

  // New shape: { items: [...] }
  if (typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as any;
    if (Array.isArray(obj.items)) {
      const items: FeedItem[] = obj.items
        .map((it: any, idx: number): FeedItem | null => {
          const date = typeof it?.date === "string" ? it.date : "";
          const text = typeof it?.text === "string" ? it.text : "";
          const id =
            typeof it?.id === "string"
              ? it.id
              : typeof it?.generated_at === "string"
                ? it.generated_at
                : date || String(idx);
          if (!date || !text) return null;
          const place = typeof it?.place === "string" && it.place ? it.place : undefined;
          return { id, date, text, place };
        })
        .filter(Boolean) as FeedItem[];

      return {
        updated_at: typeof obj.updated_at === "string" ? obj.updated_at : undefined,
        place: typeof obj.place === "string" ? obj.place : undefined,
        items,
      };
    }
  }

  // Legacy shape: [ {date, text, ...}, ... ]
  if (Array.isArray(parsed)) {
    const items: FeedItem[] = parsed
      .map((it: any, idx: number): FeedItem | null => {
        const date = typeof it?.date === "string" ? it.date : "";
        const text = typeof it?.text === "string" ? it.text : "";
        const id =
          typeof it?.id === "string"
            ? it.id
            : typeof it?.generated_at === "string"
              ? it.generated_at
              : date || String(idx);
        if (!date || !text) return null;
        const place = typeof it?.place === "string" && it.place ? it.place : undefined;
        return { id, date, text, place };
      })
      .filter(Boolean) as FeedItem[];

    // Try to preserve a couple of top-level fields
    const last = parsed.length > 0 ? (parsed[parsed.length - 1] as any) : null;
    const updated_at = typeof last?.generated_at === "string" ? last.generated_at : undefined;
    const place = typeof last?.place === "string" ? last.place : undefined;

    return { updated_at, place, items };
  }

  return null;
}

function addCacheBuster(url: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${Date.now()}`;
}

export default function DiaryScreen() {
  const FEED_URL = process.env.EXPO_PUBLIC_FEED_URL || "./weather_feed.json";

  const RESOLVED_FEED_URL = useMemo(() => {
    try {
      if (FEED_URL.startsWith("http://") || FEED_URL.startsWith("https://")) return FEED_URL;
      if (typeof window !== "undefined") return new URL(FEED_URL, window.location.href).toString();
    } catch {
      // ignore
    }
    return FEED_URL;
  }, [FEED_URL]);

  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const sortedItems = useMemo(() => {
    const items = feed?.items ?? [];
    return [...items].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }, [feed]);

  const latest = sortedItems[0] ?? null;

  const load = useCallback(async () => {
    try {
      setError(null);
      const fetchUrl = addCacheBuster(RESOLVED_FEED_URL);
      const res = await fetch(fetchUrl, { headers: { "Cache-Control": "no-cache" } });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const raw = await res.text();
      const parsed = safeJsonParse(raw);
      const normalized = normalizeFeed(parsed);
      if (!normalized) {
        const preview = raw.slice(0, 180).replace(/\s+/g, " ").trim();
        throw new Error(`Invalid feed JSON shape\nURL: ${RESOLVED_FEED_URL}\nRAW: ${preview}`);
      }
      setFeed(normalized);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load feed");
      setFeed(null);
    } finally {
      setLoading(false);
    }
  }, [RESOLVED_FEED_URL]);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const openFeed = useCallback(() => {
    if (!RESOLVED_FEED_URL) return;
    void Linking.openURL(RESOLVED_FEED_URL);
  }, [RESOLVED_FEED_URL]);

  const Header = (
    <View style={{ padding: 16, gap: 10 }}>
      <View style={{ gap: 6 }}>
        <Text style={{ fontSize: 22, fontWeight: "800", color: "#fff" }}>Weather Diary</Text>
        <Text style={{ color: TEXT_DIM }}>
          Friendly Yokosuka weather bot posts (generated daily by the backend + RAG).
        </Text>
        <Text style={{ color: TEXT_DIM, fontSize: 12 }}>Feed: {RESOLVED_FEED_URL}</Text>
      </View>

      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <TouchableOpacity
          onPress={openFeed}
          style={{
            backgroundColor: "#fff",
            paddingVertical: 8,
            paddingHorizontal: 12,
            borderRadius: 10,
          }}
        >
          <Text style={{ fontWeight: "800" }}>Open feed JSON</Text>
        </TouchableOpacity>

        {feed?.updated_at ? <Text style={{ color: TEXT_DIM }}>Updated: {feed.updated_at}</Text> : null}
      </View>

      {latest ? (
        <View
          style={{
            backgroundColor: CARD_BG,
            borderRadius: 14,
            padding: 14,
            borderWidth: 1,
            borderColor: "#1f2937",
          }}
        >
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "800" }}>Latest ({latest.date})</Text>
          {latest.place ? <Text style={{ color: TEXT_DIM, marginTop: 4 }}>{latest.place}</Text> : null}
          <Text style={{ color: "#fff", marginTop: 10, fontSize: 16, lineHeight: 22 }}>{latest.text}</Text>
        </View>
      ) : null}

      {error ? (
        <View
          style={{
            backgroundColor: "#7f1d1d",
            borderRadius: 14,
            padding: 12,
          }}
        >
          <Text style={{ color: "#fff", fontWeight: "800" }}>Error</Text>
          <Text style={{ color: "#fee2e2", marginTop: 6 }}>{error}</Text>
        </View>
      ) : null}
    </View>
  );

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 16 }}>
        <ActivityIndicator />
        <Text style={{ marginTop: 10, color: TEXT_DIM }}>Loading…</Text>
      </View>
    );
  }

  return (
    <FlatList
      data={sortedItems}
      keyExtractor={(it) => it.id}
      ListHeaderComponent={Header}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      renderItem={({ item }) => (
        <View style={{ paddingHorizontal: 16, paddingBottom: 12 }}>
          <View
            style={{
              backgroundColor: CARD_BG,
              borderRadius: 14,
              padding: 14,
              borderWidth: 1,
              borderColor: "#1f2937",
            }}
          >
            <Text style={{ color: TEXT_DIM, fontWeight: "700" }}>{item.date}</Text>
            {item.place ? <Text style={{ color: TEXT_DIM, marginTop: 4 }}>{item.place}</Text> : null}
            <Text style={{ color: "#fff", marginTop: 8, fontSize: 16, lineHeight: 22 }}>{item.text}</Text>
          </View>
        </View>
      )}
      ListEmptyComponent={
        <View style={{ padding: 16 }}>
          <Text style={{ color: TEXT_DIM }}>No posts yet.</Text>
        </View>
      }
    />
  );
}
