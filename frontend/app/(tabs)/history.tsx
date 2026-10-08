import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowClockwise, MagnifyingGlass } from "phosphor-react-native";

import { HistoryItem, getHistory, resendMessage } from "@/src/api";
import { Button, ConfirmSheet, EmptyState, StatusBadge } from "@/src/components/ui";
import { useToast } from "@/src/components/toast";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

const FILTERS = ["All", "Sent", "Failed", "Pending"] as const;

function statusBadge(status: string) {
  if (status === "SENT") return { kind: "success" as const, label: "Sent" };
  if (status === "FAILED") return { kind: "error" as const, label: "Failed" };
  if (status === "SENDING") return { kind: "warning" as const, label: "Sending" };
  return { kind: "warning" as const, label: "Pending" };
}

export default function History() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>("All");
  const [search, setSearch] = useState("");
  const [resendItem, setResendItem] = useState<HistoryItem | null>(null);
  const [resending, setResending] = useState(false);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["history", filter, search],
    queryFn: () => getHistory(filter.toLowerCase(), search),
    refetchInterval: 6000,
  });

  async function doResend() {
    if (!resendItem) return;
    setResending(true);
    try {
      const res = await resendMessage(resendItem.message_id);
      setResendItem(null);
      qc.invalidateQueries({ queryKey: ["batches"] });
      router.push({ pathname: "/batch/[id]", params: { id: res.batch_id } });
    } catch (e: any) {
      toast(e?.message || "Resend failed", "error");
    } finally {
      setResending(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={styles.title}>History</Text>
        <View style={styles.searchBox}>
          <MagnifyingGlass size={18} color={colors.muted} />
          <TextInput
            testID="history-search"
            placeholder="Search number, message ID..."
            placeholderTextColor={colors.muted}
            value={search}
            onChangeText={setSearch}
            style={styles.searchInput}
            returnKeyType="search"
          />
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chipsRow}
          style={styles.chipsScroll}
        >
          {FILTERS.map((f) => {
            const active = filter === f;
            return (
              <Pressable
                key={f}
                testID={`filter-${f.toLowerCase()}`}
                onPress={() => setFilter(f)}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Text style={[styles.chipText, active && styles.chipTextActive]}>{f}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : (
        <FlatList
          data={data?.items ?? []}
          keyExtractor={(item) => item.message_id}
          contentContainerStyle={styles.listContent}
          onRefresh={refetch}
          refreshing={isRefetching}
          renderItem={({ item }) => <HistoryCard item={item} onResend={() => setResendItem(item)} />}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Image
                source={{ uri: "https://images.unsplash.com/photo-1468779036391-52341f60b55d?crop=entropy&cs=srgb&fm=jpg&ixid=M3w4NjA1NzR8MHwxfHNlYXJjaHwxfHxlbXB0eSUyMGZvbGRlciUyMGZpbGUlMjBkb2N1bWVudHxlbnwwfHx8fDE3OTAwNTY1MTJ8MA&ixlib=rb-4.1.0&q=85" }}
                style={styles.emptyImg}
              />
              <EmptyState title="No SMS history found" subtitle="Bhejne ke baad yahan har message ka status dikhega." />
            </View>
          }
        />
      )}

      <ConfirmSheet
        visible={resendItem !== null}
        title="Resend this SMS?"
        message={`A new sending job will be created for ${resendItem?.mobile_number ?? ""}. The original history record stays unchanged.`}
        confirmLabel={resending ? "Creating..." : "Resend"}
        onConfirm={doResend}
        onCancel={() => setResendItem(null)}
      />
    </View>
  );
}

function HistoryCard({ item, onResend }: { item: HistoryItem; onResend: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const b = statusBadge(item.status);
  const time = item.updated_at ? new Date(item.updated_at).toLocaleString() : "";
  const canResend = item.status === "SENT" || item.status === "FAILED";
  return (
    <View style={styles.card} testID={`history-item-${item.message_id}`}>
      <View style={styles.cardTop}>
        <Text style={styles.mobile}>{item.mobile_number}</Text>
        <StatusBadge kind={b.kind} label={b.label} />
      </View>
      <Text style={styles.message} numberOfLines={2}>
        {item.message}
      </Text>
      <View style={styles.cardBottom}>
        <Text style={styles.meta}>{item.job_id || item.message_id}</Text>
        <Text style={styles.meta}>{time}</Text>
      </View>
      {item.error_message ? <Text style={styles.error}>{item.error_message}</Text> : null}
      {item.simulated ? <Text style={styles.sim}>simulated (demo)</Text> : null}
      {canResend ? (
        <Button
          label="Resend"
          variant="secondary"
          onPress={onResend}
          testID={`resend-${item.message_id}`}
          icon={<ArrowClockwise size={16} color={colors.onSurface} weight="bold" />}
          style={{ marginTop: spacing.xs }}
        />
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
    gap: spacing.md,
  },
  title: { fontSize: 24, fontWeight: "800", color: colors.onSurface },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, paddingVertical: 12, fontSize: 15, color: colors.onSurface },
  chipsScroll: { flexGrow: 0 },
  chipsRow: { gap: spacing.sm, paddingRight: spacing.lg },
  chip: {
    height: 36,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    flexShrink: 0,
  },
  chipActive: { backgroundColor: colors.brandPrimary, borderColor: colors.brandPrimary },
  chipText: { fontSize: 14, fontWeight: "700", color: colors.onSurfaceTertiary },
  chipTextActive: { color: colors.onBrandPrimary },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1 },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  mobile: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
  message: { fontSize: 14, color: colors.onSurfaceTertiary, lineHeight: 19 },
  cardBottom: { flexDirection: "row", justifyContent: "space-between" },
  meta: { fontSize: 11, color: colors.muted },
  error: { fontSize: 12, color: colors.error, fontWeight: "600" },
  sim: { fontSize: 11, color: colors.warning, fontStyle: "italic" },
  emptyWrap: { alignItems: "center", gap: spacing.md, paddingTop: spacing.xl },
  emptyImg: { width: "100%", height: 160, borderRadius: radius.lg, opacity: 0.85 },
}));
