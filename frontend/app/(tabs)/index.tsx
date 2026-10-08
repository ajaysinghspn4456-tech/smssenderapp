import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ListChecks, PaperPlaneTilt, TestTube } from "phosphor-react-native";

import { getDashboard } from "@/src/api";
import { DemoBanner, Button, Card, StatCard, StatusBadge } from "@/src/components/ui";
import { DEMO_MODE } from "@/src/gateway/nativeSms";
import { makeStyles, spacing, useTheme } from "@/src/theme";

function StatusLine({
  label,
  ok,
  okText,
  noText,
  testID,
}: {
  label: string;
  ok: boolean;
  okText: string;
  noText: string;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <View style={styles.statusLine} testID={testID}>
      <Text style={styles.statusLineLabel}>{label}</Text>
      <StatusBadge kind={ok ? "success" : "error"} label={ok ? okText : noText} />
    </View>
  );
}

export default function Dashboard() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors } = useTheme();

  const { data, isLoading, refetch, isRefetching, isError } = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboard,
    refetchInterval: 3000,
  });

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />}
    >
      <View style={styles.headerRow}>
        <Image
          source={require("../../assets/images/uppcl-logo-crop.png")}
          style={styles.logo}
          contentFit="contain"
          testID="app-logo"
        />
        <View style={{ flex: 1 }}>
          <Text style={styles.hello}>UPPCL Suchna Seva</Text>
          <Text style={styles.gatewayId}>{data?.gateway_id ?? "PHONE-001"}</Text>
        </View>
      </View>

      {DEMO_MODE ? <DemoBanner /> : null}

      {isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.brandPrimary} />
          <Text style={styles.loadingText}>Checking gateway status...</Text>
        </View>
      ) : isError ? (
        <Card style={{ marginHorizontal: spacing.lg }}>
          <Text style={styles.errorText}>Unable to load stats.</Text>
          <Button label="Retry" onPress={refetch} testID="dashboard-retry" style={{ marginTop: spacing.md }} />
        </Card>
      ) : (
        <>
          <View style={styles.statusWrap}>
            <Card testID="gateway-status-card">
              <View style={styles.statusHeaderRow}>
                <Text style={styles.cardHeading}>Gateway status</Text>
                <StatusBadge
                  testID="gateway-state-badge"
                  kind={
                    data?.gateway_state === "READY" || data?.gateway_state === "BUSY"
                      ? "success"
                      : data?.gateway_state === "ERROR"
                        ? "warning"
                        : "error"
                  }
                  label={data?.gateway_state ?? "—"}
                />
              </View>
              <StatusLine label="Phone" ok={!!data?.connected} okText="Connected" noText="Disconnected" testID="status-phone" />
              <StatusLine label="SIM" ok={!!data?.sim_available} okText="Available" noText="Not available" testID="status-sim" />
              <StatusLine label="SMS Permission" ok={!!data?.sms_permission} okText="Granted" noText="Denied" testID="status-permission" />
              <StatusLine label="Network" ok={!!data?.network_connected} okText="Connected" noText="Disconnected" testID="status-network" />
            </Card>
          </View>

          <View style={styles.section}>
            <Card testID="today-sent-card" style={styles.heroCard}>
              <Text style={styles.heroLabel}>Today's SMS Sent</Text>
              <Text style={styles.heroValue}>{data?.today_sent ?? 0}</Text>
              <Text style={styles.heroSub}>{data?.today_total ?? 0} total attempted today</Text>
            </Card>

            <View style={styles.grid}>
              <StatCard testID="stat-pending" label="Pending" value={data?.today_pending ?? 0} kind="warning" />
              <StatCard testID="stat-failed" label="Failed" value={data?.today_failed ?? 0} kind="error" />
            </View>

            {data?.current_job ? (
              <Card style={styles.activity} testID="current-job-card">
                <Text style={styles.activityLabel}>Current job</Text>
                <Text style={styles.activityText}>
                  {data.current_job.job_id} · {data.current_job.mobile_number}
                </Text>
              </Card>
            ) : data?.last_activity ? (
              <Card style={styles.activity}>
                <Text style={styles.activityLabel}>Last activity</Text>
                <Text style={styles.activityText}>
                  {data.last_activity.mobile_number} · {data.last_activity.status}
                </Text>
              </Card>
            ) : null}
          </View>

          <View style={styles.actions}>
            <Button
              label="Upload Excel"
              icon={<PaperPlaneTilt size={18} color={colors.onBrandPrimary} weight="fill" />}
              onPress={() => router.push("/(tabs)/upload")}
              testID="action-upload"
            />
            <Button
              label="Send Test SMS"
              variant="secondary"
              icon={<TestTube size={18} color={colors.onSurface} weight="fill" />}
              onPress={() => router.push("/test-sms")}
              testID="action-test-sms"
            />
            <Button
              label="Sending Jobs"
              variant="secondary"
              icon={<ListChecks size={18} color={colors.onSurface} weight="fill" />}
              onPress={() => router.push("/jobs")}
              testID="action-jobs"
            />
            <View style={styles.actionRow}>
              <Button label="History" variant="secondary" onPress={() => router.push("/(tabs)/history")} testID="action-history" style={{ flex: 1 }} />
              <Button label="Settings" variant="secondary" onPress={() => router.push("/(tabs)/settings")} testID="action-settings" style={{ flex: 1 }} />
            </View>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.surface },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  logo: { width: 52, height: 52, borderRadius: 12 },
  hello: { fontSize: 24, fontWeight: "800", color: colors.onSurface },
  gatewayId: { fontSize: 13, color: colors.muted, marginTop: 2, fontWeight: "600" },
  loading: { padding: spacing["2xl"], alignItems: "center", gap: spacing.sm },
  loadingText: { color: colors.muted, fontSize: 14 },
  errorText: { color: colors.error, fontSize: 15, fontWeight: "600" },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
    alignItems: "center",
  },
  badgeItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  statusWrap: { paddingHorizontal: spacing.lg, marginBottom: spacing.md },
  statusHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.sm },
  cardHeading: { fontSize: 15, fontWeight: "800", color: colors.onSurface },
  statusLine: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 7 },
  statusLineLabel: { fontSize: 14, color: colors.onSurfaceSecondary, fontWeight: "600" },
  section: { paddingHorizontal: spacing.lg, gap: spacing.md },
  heroCard: { backgroundColor: colors.surfaceInverse, borderColor: colors.surfaceInverse },
  heroLabel: { color: colors.onSurfaceInverse, opacity: 0.7, fontSize: 14, fontWeight: "600" },
  heroValue: { color: colors.onSurfaceInverse, fontSize: 52, fontWeight: "900", marginVertical: 2 },
  heroSub: { color: colors.onSurfaceInverse, opacity: 0.6, fontSize: 13 },
  grid: { flexDirection: "row", gap: spacing.md },
  activity: { paddingVertical: spacing.md },
  activityLabel: { fontSize: 12, color: colors.muted, fontWeight: "700", textTransform: "uppercase" },
  activityText: { fontSize: 15, color: colors.onSurface, fontWeight: "600", marginTop: 4 },
  actions: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  actionRow: { flexDirection: "row", gap: spacing.sm },
}));
