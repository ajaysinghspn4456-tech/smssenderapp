import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowClockwise, ArrowLeft, Prohibit } from "phosphor-react-native";

import { BatchListItem, cancelAllJobs, controlBatch, listBatches, resendBatch, resendFailed } from "@/src/api";
import { Button, Card, ConfirmSheet, EmptyState, StatusBadge } from "@/src/components/ui";
import { useToast } from "@/src/components/toast";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

function statusKind(s: string) {
  if (s === "COMPLETED") return "success" as const;
  if (s === "FAILED") return "error" as const;
  if (s === "CANCELLED") return "muted" as const;
  if (s === "PAUSED") return "warning" as const;
  return "warning" as const; // RUNNING
}

export default function JobsScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const qc = useQueryClient();

  const [confirmAll, setConfirmAll] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["batches"],
    queryFn: listBatches,
    refetchInterval: 2000,
  });

  const items = data?.items ?? [];
  const activeCount = items.filter(
    (b) => (b.control_state === "running" || b.control_state === "paused") && b.pending > 0,
  ).length;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["batches"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  }

  async function doCancel(id: string) {
    setCancelId(null);
    setBusyId(id);
    try {
      await controlBatch(id, "cancel");
      invalidate();
      toast("Job cancelled", "success");
    } catch (e: any) {
      toast(e?.message || "Cancel failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function doCancelAll() {
    setConfirmAll(false);
    try {
      const res = await cancelAllJobs();
      invalidate();
      toast(`${res.cancelled_batches} job(s) cancelled`, "success");
    } catch (e: any) {
      toast(e?.message || "Cancel all failed", "error");
    }
  }

  async function doResend(id: string) {
    setBusyId(id);
    try {
      const res = await resendBatch(id);
      invalidate();
      router.push({ pathname: "/batch/[id]", params: { id: res.batch_id } });
    } catch (e: any) {
      toast(e?.message || "Resend failed", "error");
    } finally {
      setBusyId(null);
    }
  }

  async function doResendFailed(id: string) {
    setBusyId(id);
    try {
      const res = await resendFailed(id);
      invalidate();
      router.push({ pathname: "/batch/[id]", params: { id: res.batch_id } });
    } catch (e: any) {
      toast(e?.message || "No failed messages", "error");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.replace("/(tabs)")} hitSlop={8} testID="jobs-back">
          <ArrowLeft size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>Sending Jobs</Text>
      </View>

      {activeCount > 0 ? (
        <View style={styles.cancelAllWrap}>
          <Button
            label={`Cancel All Pending Jobs (${activeCount})`}
            variant="danger"
            icon={<Prohibit size={18} color={colors.onError} weight="fill" />}
            onPress={() => setConfirmAll(true)}
            testID="cancel-all-button"
          />
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.center}><ActivityIndicator color={colors.brandPrimary} /></View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(b) => b.batch_id}
          contentContainerStyle={styles.listContent}
          onRefresh={refetch}
          refreshing={isRefetching}
          renderItem={({ item }) => (
            <JobCard
              item={item}
              busy={busyId === item.batch_id}
              onOpen={() => router.push({ pathname: "/batch/[id]", params: { id: item.batch_id } })}
              onCancel={() => setCancelId(item.batch_id)}
              onResend={() => doResend(item.batch_id)}
              onResendFailed={() => doResendFailed(item.batch_id)}
            />
          )}
          ListEmptyComponent={
            <EmptyState title="No jobs yet" subtitle="Upload a list to start a sending job — it will appear here." />
          }
        />
      )}

      <ConfirmSheet
        visible={confirmAll}
        title="Cancel all pending jobs?"
        message={`Are you sure you want to cancel all ${activeCount} pending job(s)? Already sent messages stay sent and are never resent.`}
        confirmLabel="Cancel All"
        cancelLabel="Keep Jobs"
        danger
        onConfirm={doCancelAll}
        onCancel={() => setConfirmAll(false)}
      />
      <ConfirmSheet
        visible={cancelId !== null}
        title="Cancel this job?"
        message="Pending messages will be cancelled. Already sent messages stay sent and are never resent."
        confirmLabel="Cancel Job"
        cancelLabel="Keep Sending"
        danger
        onConfirm={() => doCancel(cancelId!)}
        onCancel={() => setCancelId(null)}
      />
    </View>
  );
}

function JobCard({
  item,
  busy,
  onOpen,
  onCancel,
  onResend,
  onResendFailed,
}: {
  item: BatchListItem;
  busy: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onResend: () => void;
  onResendFailed: () => void;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const done = item.sent + item.failed + item.cancelled;
  const percent = item.total > 0 ? Math.round((done / item.total) * 100) : 0;
  const canCancel = (item.control_state === "running" || item.control_state === "paused") && item.pending > 0;
  const finished = item.display_status === "COMPLETED" || item.display_status === "CANCELLED" || item.display_status === "FAILED";

  return (
    <Pressable style={styles.card} onPress={onOpen} testID={`job-${item.batch_id}`}>
      <View style={styles.cardTop}>
        <Text style={styles.jobName} numberOfLines={1}>{item.name}</Text>
        <StatusBadge kind={statusKind(item.display_status)} label={item.display_status} />
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${percent}%` }]} />
      </View>
      <Text style={styles.counts}>
        {item.sent} sent · {item.failed} failed · {item.pending} pending{item.cancelled > 0 ? ` · ${item.cancelled} cancelled` : ""} · {item.total} total
      </Text>
      <View style={styles.actions}>
        {canCancel ? (
          <Button
            label="Cancel"
            variant="danger"
            onPress={onCancel}
            loading={busy}
            testID={`cancel-${item.batch_id}`}
            style={{ flex: 1 }}
            icon={<Prohibit size={16} color={colors.onError} weight="fill" />}
          />
        ) : null}
        {finished ? (
          <Button
            label="Resend"
            variant="secondary"
            onPress={onResend}
            loading={busy}
            testID={`resend-batch-${item.batch_id}`}
            style={{ flex: 1 }}
            icon={<ArrowClockwise size={16} color={colors.onSurface} weight="bold" />}
          />
        ) : null}
        {finished && item.failed > 0 ? (
          <Button
            label={`Resend Failed (${item.failed})`}
            variant="secondary"
            onPress={onResendFailed}
            loading={busy}
            testID={`resend-failed-${item.batch_id}`}
            style={{ flex: 1 }}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.onSurface },
  cancelAllWrap: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { padding: spacing.lg, gap: spacing.sm, flexGrow: 1 },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  jobName: { fontSize: 15, fontWeight: "800", color: colors.onSurface, flex: 1 },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  fill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.success },
  counts: { fontSize: 12.5, color: colors.muted, fontWeight: "600" },
  actions: { flexDirection: "row", gap: spacing.sm },
}));
