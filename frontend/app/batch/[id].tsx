import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, DownloadSimple, Info, Pause, Play, Prohibit, Stop } from "phosphor-react-native";

import { BatchStatus, controlBatch, exportUrl, getBatch, resendFailed } from "@/src/api";
import { Button, Card, ConfirmSheet, DemoBanner, StatCard, StatusBadge } from "@/src/components/ui";
import { useToast } from "@/src/components/toast";
import { DEMO_MODE, requestSmsPermission } from "@/src/gateway/nativeSms";
import { hasForegroundService, isSending, startSending, stopSending } from "@/src/gateway/sender";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function BatchScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const qc = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [permBlocked, setPermBlocked] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const { data: batch } = useQuery({
    queryKey: ["batch", id],
    queryFn: () => getBatch(id!),
    refetchInterval: 1000,
  });

  async function ensurePermissionThenStart() {
    if (!DEMO_MODE) {
      const p = await requestSmsPermission();
      if (p !== "granted") {
        setPermBlocked(p === "blocked");
        toast("SMS permission is required to send", "error");
        return;
      }
    }
    setPermBlocked(false);
    startSending(id!, () => qc.invalidateQueries({ queryKey: ["batch", id] }));
  }

  // auto-start when the batch is running and has work left
  useEffect(() => {
    if (
      batch?.control_state === "running" &&
      (batch.pending > 0 || batch.sending > 0) &&
      !isSending()
    ) {
      ensurePermissionThenStart();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.control_state, batch?.pending, batch?.sending]);

  // resume when app returns to foreground (fallback loop may have been frozen)
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active" && batch?.control_state === "running" && !isSending()) {
        ensurePermissionThenStart();
      }
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.control_state]);

  async function control(action: "pause" | "resume" | "stop" | "cancel") {
    if (action !== "resume") await stopSending();
    try {
      const b = await controlBatch(id!, action);
      qc.setQueryData(["batch", id], b);
      if (action === "resume") ensurePermissionThenStart();
    } catch (e: any) {
      toast(e?.message || "Action failed", "error");
    }
  }

  async function doExport() {
    try {
      const url = await exportUrl(id!);
      if (Platform.OS === "web") {
        Linking.openURL(url);
        return;
      }
      const target = `${FileSystem.cacheDirectory}sms_results_${id}.xlsx`;
      const dl = await FileSystem.downloadAsync(url, target);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(dl.uri, {
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      } else {
        toast("Saved to cache", "success");
      }
    } catch (e: any) {
      toast(e?.message || "Export failed", "error");
    }
  }

  const b: BatchStatus | undefined = batch;
  const done = (b?.sent ?? 0) + (b?.failed ?? 0) + (b?.cancelled ?? 0);
  const percent = b && b.total > 0 ? Math.round((done / b.total) * 100) : 0;
  const isComplete = b ? b.pending === 0 && b.sending === 0 : false;
  const isCancelled = b?.control_state === "cancelled";
  const isRunning = b?.control_state === "running" && !isComplete;
  const activity = b?.current_activity;

  const statusLabel = isCancelled
    ? "CANCELLED"
    : isComplete
      ? (b && b.failed > 0 && b.sent === 0 ? "FAILED" : "COMPLETED")
      : b?.control_state === "paused"
        ? "PAUSED"
        : "SENDING";

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.replace("/(tabs)")} hitSlop={8} testID="batch-back">
          <ArrowLeft size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>Sending SMS</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl, gap: spacing.lg }}>
        {DEMO_MODE ? <DemoBanner /> : null}

        {isRunning ? (
          <View style={styles.keepOpen} testID="background-note">
            <Info size={16} color={colors.info} weight="fill" />
            <Text style={styles.keepOpenText}>
              {hasForegroundService
                ? "Sending background me chalega — notification me progress dikhega. App band karne par bhi jaari rahega. Android ~30 SMS ke baad 'Allow' puchh sakta hai."
                : "Is screen ko khula rakhein — Android ~30 SMS ke baad 'Allow/Send' puchh sakta hai, tab tap karein."}
            </Text>
          </View>
        ) : null}

        <Card testID="progress-card">
          <View style={styles.progressTop}>
            <Text style={styles.percent}>{percent}%</Text>
            <StatusBadge
              testID="batch-status-badge"
              kind={isCancelled ? "muted" : isComplete ? "success" : "warning"}
              label={statusLabel}
            />
          </View>
          <Text style={styles.progressLabel}>{done} / {b?.total ?? 0}</Text>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
        </Card>

        <View style={styles.grid}>
          <StatCard testID="count-sent" label="Sent" value={b?.sent ?? 0} kind="success" />
          <StatCard testID="count-failed" label="Failed" value={b?.failed ?? 0} kind="error" />
        </View>
        <View style={styles.grid}>
          <StatCard testID="count-queued" label="Queued" value={b?.queued ?? 0} kind="warning" />
          <StatCard testID="count-retrying" label="Retrying" value={b?.retrying ?? 0} kind="warning" />
          <StatCard testID="count-sending" label="Sending" value={b?.sending ?? 0} />
        </View>
        {(b?.cancelled ?? 0) > 0 ? (
          <View style={styles.grid}>
            <StatCard testID="count-cancelled" label="Cancelled" value={b?.cancelled ?? 0} kind="muted" />
          </View>
        ) : null}

        <Card testID="current-activity">
          <Text style={styles.activityHeading}>Current activity</Text>
          {activity ? (
            <>
              <ActivityRow label="Job" value={activity.job_id} />
              <ActivityRow label="Mobile" value={activity.mobile_number} />
              <View style={styles.activityRow}>
                <Text style={styles.activityLabel}>Status</Text>
                <StatusBadge kind="warning" label={`SENDING${activity.attempts > 1 ? ` (try ${activity.attempts})` : ""}`} />
              </View>
            </>
          ) : (
            <Text style={styles.idleText}>
              {isCancelled ? "Cancelled" : isComplete ? "Finished" : isRunning ? "Preparing next message..." : "Paused"}
            </Text>
          )}
        </Card>

        {permBlocked ? (
          <Card>
            <Text style={styles.permText}>SMS permission is blocked. Enable it in Settings to send.</Text>
            <Button label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} testID="open-settings" style={{ marginTop: spacing.md }} />
          </Card>
        ) : null}

        {isComplete || isCancelled ? (
          <Card testID="complete-card">
            <Text style={styles.completeTitle}>{isCancelled ? "Job cancelled" : "Sending complete"}</Text>
            <Text style={styles.completeSub}>
              {b?.sent ?? 0} sent · {b?.failed ?? 0} failed{(b?.cancelled ?? 0) > 0 ? ` · ${b?.cancelled} cancelled` : ""}
            </Text>
            <Button
              label="Export Results"
              icon={<DownloadSimple size={18} color={colors.onBrandPrimary} weight="bold" />}
              onPress={doExport}
              testID="export-results"
              style={{ marginTop: spacing.md }}
            />
            {(b?.failed ?? 0) > 0 ? (
              <Button
                label={`Resend Failed (${b?.failed})`}
                variant="secondary"
                onPress={async () => {
                  try {
                    const res = await resendFailed(id!);
                    router.replace({ pathname: "/batch/[id]", params: { id: res.batch_id } });
                  } catch (e: any) {
                    toast(e?.message || "Resend failed", "error");
                  }
                }}
                testID="resend-failed-button"
                style={{ marginTop: spacing.sm }}
              />
            ) : null}
            <Button label="Back to Dashboard" variant="secondary" onPress={() => router.replace("/(tabs)")} testID="batch-done" style={{ marginTop: spacing.sm }} />
          </Card>
        ) : null}
      </ScrollView>

      {!isComplete && !isCancelled ? (
        <View style={[styles.controls, { paddingBottom: insets.bottom + spacing.md }]}>
          {isRunning ? (
            <Button
              label="Pause"
              variant="secondary"
              icon={<Pause size={18} color={colors.onSurface} weight="fill" />}
              onPress={() => control("pause")}
              testID="pause-button"
              style={{ flex: 1 }}
            />
          ) : (
            <Button
              label="Resume"
              icon={<Play size={18} color={colors.onBrandPrimary} weight="fill" />}
              onPress={() => control("resume")}
              testID="resume-button"
              style={{ flex: 1 }}
            />
          )}
          <Button
            label="Cancel"
            variant="danger"
            icon={<Prohibit size={18} color={colors.onError} weight="fill" />}
            onPress={() => setConfirmCancel(true)}
            testID="cancel-batch-button"
            style={{ flex: 1 }}
          />
        </View>
      ) : null}

      <ConfirmSheet
        visible={confirmCancel}
        title="Cancel this job?"
        message={`${b?.pending ?? 0} pending message(s) will be cancelled. Already sent messages stay sent and are never resent.`}
        confirmLabel="Cancel Job"
        cancelLabel="Keep Sending"
        danger
        onConfirm={() => {
          setConfirmCancel(false);
          control("cancel");
        }}
        onCancel={() => setConfirmCancel(false)}
      />
    </View>
  );
}

function ActivityRow({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.activityRow}>
      <Text style={styles.activityLabel}>{label}</Text>
      <Text style={styles.activityValue} numberOfLines={1}>{value}</Text>
    </View>
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
  keepOpen: {
    flexDirection: "row",
    gap: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  keepOpenText: { flex: 1, fontSize: 12.5, color: colors.onSurfaceSecondary, lineHeight: 17 },
  progressTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  percent: { fontSize: 40, fontWeight: "900", color: colors.onSurface },
  progressLabel: { fontSize: 13, color: colors.muted, fontWeight: "600", marginBottom: spacing.sm },
  track: { height: 12, borderRadius: radius.pill, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  fill: { height: 12, borderRadius: radius.pill, backgroundColor: colors.success },
  grid: { flexDirection: "row", gap: spacing.md },
  activityHeading: { fontSize: 13, fontWeight: "800", color: colors.muted, textTransform: "uppercase", marginBottom: spacing.sm },
  activityRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 5, gap: spacing.md },
  activityLabel: { fontSize: 14, color: colors.muted, fontWeight: "600" },
  activityValue: { fontSize: 14, color: colors.onSurface, fontWeight: "700", flexShrink: 1, textAlign: "right" },
  idleText: { fontSize: 14, color: colors.onSurfaceTertiary },
  permText: { fontSize: 14, color: colors.error, fontWeight: "600", lineHeight: 20 },
  completeTitle: { fontSize: 18, fontWeight: "800", color: colors.success },
  completeSub: { fontSize: 14, color: colors.muted, marginTop: 4 },
  controls: {
    flexDirection: "row",
    gap: spacing.sm,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
}));
