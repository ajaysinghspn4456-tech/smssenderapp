import * as Clipboard from "expo-clipboard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowClockwise, Copy, Eye, EyeSlash, Minus, Plus, ShieldWarning } from "phosphor-react-native";

import {
  TOKEN_KEY,
  getSettings,
  regenerateToken,
  revokeToken,
  updateSettings,
} from "@/src/api";
import { Button, Card, ConfirmSheet, StatusBadge } from "@/src/components/ui";
import { useToast } from "@/src/components/toast";
import { DEMO_MODE, getSimCards, requestPhoneStatePermission, SimCard } from "@/src/gateway/nativeSms";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";
import { storage } from "@/src/utils/storage";

export default function Settings() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const { colors } = useTheme();
  const qc = useQueryClient();

  const { data: settings, isLoading } = useQuery({ queryKey: ["settings"], queryFn: getSettings });

  const [reveal, setReveal] = useState(false);
  const [delay, setDelay] = useState(3);
  const [chunkSize, setChunkSize] = useState(0);
  const [countryCode, setCountryCode] = useState("+91");
  const [sims, setSims] = useState<SimCard[]>([]);
  const [confirm, setConfirm] = useState<null | "regenerate" | "revoke">(null);

  useEffect(() => {
    if (settings) {
      setDelay(settings.sending_delay);
      setChunkSize(settings.chunk_size ?? 0);
      setCountryCode(settings.default_country_code);
    }
  }, [settings]);

  useEffect(() => {
    (async () => {
      if (!DEMO_MODE) {
        await requestPhoneStatePermission();
        setSims(await getSimCards());
      }
    })();
  }, []);

  async function save(partial: any) {
    await updateSettings(partial);
    qc.invalidateQueries({ queryKey: ["settings"] });
    toast("Settings saved", "success");
  }

  async function copyToken() {
    if (!settings?.token) return;
    await Clipboard.setStringAsync(settings.token);
    toast("Token copied", "success");
  }

  async function doRegenerate() {
    setConfirm(null);
    const res = await regenerateToken();
    await storage.secureSet(TOKEN_KEY, res.token);
    qc.invalidateQueries({ queryKey: ["settings"] });
    toast("New token generated", "success");
  }

  async function doRevoke() {
    setConfirm(null);
    const res = await revokeToken();
    await storage.secureSet(TOKEN_KEY, res.token);
    qc.invalidateQueries({ queryKey: ["settings"] });
    toast("Token revoked & rotated", "success");
  }

  if (isLoading || !settings) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.brandPrimary} />
      </View>
    );
  }

  const maskedToken = reveal ? settings.token : "•".repeat(Math.min(settings.token.length, 24));

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing["2xl"] }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Gateway Settings</Text>

      <View style={styles.body}>
        {/* Connection */}
        <Card>
          <Text style={styles.groupTitle}>Gateway connection</Text>
          <Row label="Gateway ID" value={settings.gateway_id} />
          <View style={styles.divider} />
          <View style={styles.rowBetween}>
            <Text style={styles.rowLabel}>Status</Text>
            <StatusBadge
              kind={settings.connected ? "success" : "error"}
              label={settings.connected ? "Connected" : "Offline"}
            />
          </View>
          <View style={styles.divider} />
          <View style={styles.rowBetween}>
            <Text style={styles.rowLabel}>Mode</Text>
            <StatusBadge kind={DEMO_MODE ? "warning" : "success"} label={DEMO_MODE ? "Demo (no build)" : "Native SMS"} />
          </View>
        </Card>

        {/* Token */}
        <Card>
          <Text style={styles.groupTitle}>Gateway token</Text>
          <Text style={styles.tokenLabel}>Private token — never shared publicly</Text>
          <View style={styles.tokenBox}>
            <Text style={styles.tokenText} numberOfLines={1} testID="gateway-token-text">
              {maskedToken}
            </Text>
            <Pressable onPress={() => setReveal((v) => !v)} testID="toggle-token-reveal" hitSlop={8}>
              {reveal ? <EyeSlash size={18} color={colors.muted} /> : <Eye size={18} color={colors.muted} />}
            </Pressable>
          </View>
          <View style={styles.tokenActions}>
            <Button label="Copy" variant="secondary" icon={<Copy size={16} color={colors.onSurface} />} onPress={copyToken} testID="copy-token" style={{ flex: 1 }} />
            <Button label="Regenerate" variant="secondary" icon={<ArrowClockwise size={16} color={colors.onSurface} />} onPress={() => setConfirm("regenerate")} testID="regenerate-token" style={{ flex: 1 }} />
          </View>
          <Button
            label="Revoke token"
            variant="danger"
            icon={<ShieldWarning size={16} color={colors.onError} weight="fill" />}
            onPress={() => setConfirm("revoke")}
            testID="revoke-token"
            style={{ marginTop: spacing.sm }}
          />
        </Card>

        {/* Sending preferences */}
        <Card>
          <Text style={styles.groupTitle}>Sending preferences</Text>

          <Text style={styles.rowLabel}>Delay between SMS</Text>
          <View style={styles.stepper}>
            <Pressable
              style={styles.stepBtn}
              testID="delay-minus"
              onPress={() => setDelay((d) => Math.max(0, d - 1))}
            >
              <Minus size={18} color={colors.onSurface} weight="bold" />
            </Pressable>
            <Text style={styles.stepValue}>{delay}s</Text>
            <Pressable
              style={styles.stepBtn}
              testID="delay-plus"
              onPress={() => setDelay((d) => Math.min(60, d + 1))}
            >
              <Plus size={18} color={colors.onSurface} weight="bold" />
            </Pressable>
            {delay !== settings.sending_delay ? (
              <Button label="Save" onPress={() => save({ sending_delay: delay })} testID="save-delay" style={{ marginLeft: "auto" }} />
            ) : null}
          </View>

          <View style={styles.divider} />
          <Text style={styles.rowLabel}>Default country code</Text>
          <View style={styles.ccRow}>
            <TextInput
              testID="country-code-input"
              value={countryCode}
              onChangeText={setCountryCode}
              placeholder="+91"
              placeholderTextColor={colors.muted}
              style={styles.ccInput}
              autoCapitalize="none"
            />
            {countryCode !== settings.default_country_code ? (
              <Button label="Save" onPress={() => save({ default_country_code: countryCode })} testID="save-cc" />
            ) : null}
          </View>

          <View style={styles.divider} />
          <Text style={styles.rowLabel}>Auto batch pause</Text>
          <Text style={styles.simNote}>
            Pause after every N messages to respect Android/carrier SMS limits on big lists. 0 = off.
          </Text>
          <View style={styles.stepper}>
            <Pressable style={styles.stepBtn} testID="chunk-minus" onPress={() => setChunkSize((c) => Math.max(0, c - 25))}>
              <Minus size={18} color={colors.onSurface} weight="bold" />
            </Pressable>
            <Text style={styles.stepValue}>{chunkSize === 0 ? "Off" : chunkSize}</Text>
            <Pressable style={styles.stepBtn} testID="chunk-plus" onPress={() => setChunkSize((c) => Math.min(500, c + 25))}>
              <Plus size={18} color={colors.onSurface} weight="bold" />
            </Pressable>
            {chunkSize !== (settings.chunk_size ?? 0) ? (
              <Button label="Save" onPress={() => save({ chunk_size: chunkSize })} testID="save-chunk" style={{ marginLeft: "auto" }} />
            ) : null}
          </View>

          <View style={styles.divider} />
          <Text style={styles.rowLabel}>SIM card</Text>
          {DEMO_MODE ? (
            <Text style={styles.simNote}>SIM selection is available on a real Android build.</Text>
          ) : sims.length === 0 ? (
            <Text style={styles.simNote}>No SIM detected. Grant phone permission and insert a SIM.</Text>
          ) : (
            <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
              {sims.map((s) => {
                const active = settings.selected_sim === s.id;
                return (
                  <Pressable
                    key={s.id}
                    testID={`sim-${s.id}`}
                    onPress={() => save({ selected_sim: s.id })}
                    style={[styles.simRow, active && styles.simRowActive]}
                  >
                    <Text style={styles.simName}>{s.displayName || s.carrierName}</Text>
                    {active ? <StatusBadge kind="success" label="Selected" /> : null}
                  </Pressable>
                );
              })}
            </View>
          )}
        </Card>

        <Text style={styles.footNote}>
          Private personal-use gateway. Bulk SMS is subject to your SIM, carrier and Android limits — this app does not bypass them.
        </Text>
      </View>

      <ConfirmSheet
        visible={confirm === "regenerate"}
        title="Regenerate token?"
        message="The old token stops working immediately. This device will keep working automatically."
        confirmLabel="Regenerate"
        onConfirm={doRegenerate}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmSheet
        visible={confirm === "revoke"}
        title="Revoke token?"
        message="The current token is invalidated and rotated. Any other client using it will be disconnected."
        confirmLabel="Revoke"
        danger
        onConfirm={doRevoke}
        onCancel={() => setConfirm(null)}
      />
    </ScrollView>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.rowBetween}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.surface },
  center: { alignItems: "center", justifyContent: "center" },
  title: { fontSize: 24, fontWeight: "800", color: colors.onSurface, paddingHorizontal: spacing.lg },
  body: { padding: spacing.lg, gap: spacing.lg },
  groupTitle: { fontSize: 16, fontWeight: "800", color: colors.onSurface, marginBottom: spacing.sm },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: spacing.sm },
  rowLabel: { fontSize: 14, color: colors.onSurfaceSecondary, fontWeight: "600" },
  rowValue: { fontSize: 14, color: colors.onSurface, fontWeight: "700" },
  divider: { height: 1, backgroundColor: colors.divider },
  tokenLabel: { fontSize: 12, color: colors.muted, marginBottom: spacing.sm },
  tokenBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tokenText: { flex: 1, fontSize: 14, color: colors.onSurface, fontFamily: "monospace" },
  tokenActions: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  stepper: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.sm },
  stepBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  stepValue: { fontSize: 18, fontWeight: "800", color: colors.onSurface, minWidth: 44, textAlign: "center" },
  ccRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center", marginTop: spacing.sm },
  ccInput: {
    flex: 1,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.onSurface,
  },
  simNote: { fontSize: 13, color: colors.muted, marginTop: spacing.sm, lineHeight: 18 },
  simRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  simRowActive: { borderColor: colors.brandPrimary },
  simName: { fontSize: 14, fontWeight: "600", color: colors.onSurface },
  footNote: { fontSize: 12, color: colors.muted, lineHeight: 18, paddingHorizontal: spacing.xs },
}));
