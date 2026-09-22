import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, DownloadSimple, Pause, Play, Stop } from "phosphor-react-native";

import {
  BatchStatus,
  exportUrl,
  getBatch,
  getSettings,
  controlBatch,
  nextJob,
  reportResult,
} from "@/src/api";
import { Button, Card, DemoBanner, StatCard } from "@/src/components/ui";
import { useToast } from "@/src/components/toast";
import { DEMO_MODE, requestSmsPermission, sendOneSms } from "@/src/gateway/nativeSms";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function BatchScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const qc = useQueryClient();
  const { id } = useLocalSearchParams<{ id: string }>();

  const engineRef = useRef(false);
  const [permBlocked, setPermBlocked] = useState(false);

  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const { data: batch } = useQuery({
    queryKey: ["batch", id],
    queryFn: () => getBatch(id!),
    refetchInterval: 1200,
  });

  const runEngine = useCallback(async () => {
    if (engineRef.current) return;
    engineRef.current = true;
    if (!DEMO_MODE) {
      const p = await requestSmsPermission();
      if (p !== "granted") {
        setPermBlocked(p === "blocked");
        toast("SMS permission is required to send", "error");
        engineRef.current = false;
        return;
      }
    }
    while (engineRef.current) {
      let res;
      try {
        res = await nextJob(id!);
      } catch {
        break;
      }
      if (!res.job) break; // paused / stopped / nothing pending
      const job = res.job;
      let result: { status: "sent" | "failed"; error_message?: string; simulated?: boolean };
      try {
        const r = await sendOneSms(job.mobile_number, job.message, settings?.selected_sim ?? undefined);
        result = { status: "sent", simulated: r.simulated };
      } catch (e: any) {
        result = { status: "failed", error_message: String(e?.message || e) };
      }
      try {
        await reportResult(job.message_id, result);
      } catch {
        // network hiccup — job stays SENDING and will be requeued on pause/resume
      }
      qc.invalidateQueries({ queryKey: ["batch", id] });
      await sleep((res.delay ?? settings?.sending_delay ?? 3) * 1000);
    }
    engineRef.current = false;
  }, [id, settings, qc, toast]);

  // auto-start when the batch is running
  useEffect(() => {
    if (batch?.control_state === "running" && (batch.pending > 0 || batch.sending > 0) && !engineRef.current) {
      runEngine();
    }
  }, [batch?.control_state, batch?.pending, batch?.sending, runEngine]);

  useEffect(() => {
    return () => {
      engineRef.current = false;
    };
  }, []);

  async function control(action: "pause" | "resume" | "stop") {
    if (action === "pause" || action === "stop") engineRef.current = false;
    try {
      const b = await controlBatch(id!, action);
      qc.setQueryData(["batch", id], b);
      if (action === "resume") runEngine();
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
  const done = (b?.total ?? 0) - (b?.pending ?? 0) - (b?.sending ?? 0);
  const percent = b && b.total > 0 ? Math.round((done / b.total) * 100) : 0;
  const isComplete = b ? b.pending === 0 && b.sending === 0 : false;
  const isRunning = b?.control_state === "running" && !isComplete;

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

        <Card testID="progress-card">
          <View style={styles.progressTop}>
            <Text style={styles.percent}>{percent}%</Text>
            <Text style={styles.progressLabel}>
              {done} / {b?.total ?? 0} {isComplete ? "· completed" : b?.control_state === "paused" ? "· paused" : "· sending"}
            </Text>
          </View>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
        </Card>

        <View style={styles.grid}>
          <StatCard testID="count-sent" label="Sent" value={b?.sent ?? 0} kind="success" />
          <StatCard testID="count-failed" label="Failed" value={b?.failed ?? 0} kind="error" />
        </View>
        <View style={styles.grid}>
          <StatCard testID="count-pending" label="Pending" value={b?.pending ?? 0} kind="warning" />
          <StatCard testID="count-sending" label="Sending" value={b?.sending ?? 0} />
        </View>

        {permBlocked ? (
          <Card>
            <Text style={styles.permText}>SMS permission is blocked. Enable it in Settings to send.</Text>
            <Button label="Open Settings" variant="secondary" onPress={() => Linking.openSettings()} testID="open-settings" style={{ marginTop: spacing.md }} />
          </Card>
        ) : null}

        {isComplete ? (
          <Card testID="complete-card">
            <Text style={styles.completeTitle}>Sending complete</Text>
            <Text style={styles.completeSub}>
              {b?.sent ?? 0} sent · {b?.failed ?? 0} failed
            </Text>
            <Button
              label="Export Results"
              icon={<DownloadSimple size={18} color={colors.onBrandPrimary} weight="bold" />}
              onPress={doExport}
              testID="export-results"
              style={{ marginTop: spacing.md }}
            />
            <Button label="Back to Dashboard" variant="secondary" onPress={() => router.replace("/(tabs)")} testID="batch-done" style={{ marginTop: spacing.sm }} />
          </Card>
        ) : null}
      </ScrollView>

      {!isComplete ? (
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
            label="Stop"
            variant="danger"
            icon={<Stop size={18} color={colors.onError} weight="fill" />}
            onPress={() => control("stop")}
            testID="stop-button"
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
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
  progressTop: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", marginBottom: spacing.md },
  percent: { fontSize: 40, fontWeight: "900", color: colors.onSurface },
  progressLabel: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  track: { height: 12, borderRadius: radius.pill, backgroundColor: colors.surfaceTertiary, overflow: "hidden" },
  fill: { height: 12, borderRadius: radius.pill, backgroundColor: colors.success },
  grid: { flexDirection: "row", gap: spacing.md },
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
