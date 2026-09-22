import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CellSignalFull, PaperPlaneTilt, SimCard, TestTube } from "phosphor-react-native";

import { getDashboard } from "@/src/api";
import { DemoBanner, Button, Card, StatCard, StatusBadge } from "@/src/components/ui";
import { DEMO_MODE } from "@/src/gateway/nativeSms";
import { makeStyles, spacing, useTheme } from "@/src/theme";

export default function Dashboard() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { colors } = useTheme();

  const { data, isLoading, refetch, isRefetching, isError } = useQuery({
    queryKey: ["dashboard"],
    queryFn: getDashboard,
    refetchInterval: 5000,
  });

  function statusKind(ok: boolean) {
    return ok ? ("success" as const) : ("error" as const);
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing.xl }}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.brandPrimary} />}
    >
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.hello}>Private SMS Gateway</Text>
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
          <View style={styles.badgeRow}>
            <StatusBadge
              testID="gateway-status-badge"
              kind={statusKind(!!data?.connected)}
              label={data?.connected ? "Connected" : "Offline"}
            />
            <View style={styles.badgeItem}>
              <SimCard size={16} color={data?.sim_available ? colors.success : colors.error} weight="fill" />
              <StatusBadge kind={statusKind(!!data?.sim_available)} label={data?.sim_available ? "SIM OK" : "No SIM"} />
            </View>
            <View style={styles.badgeItem}>
              <CellSignalFull size={16} color={data?.network_connected ? colors.success : colors.error} weight="fill" />
              <StatusBadge kind={statusKind(!!data?.network_connected)} label={data?.network_connected ? "Network" : "No Net"} />
            </View>
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

            {data?.last_activity ? (
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
  headerRow: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
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
