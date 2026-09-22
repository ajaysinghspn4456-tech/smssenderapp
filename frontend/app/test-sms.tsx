import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TestTube, X } from "phosphor-react-native";

import { createTestSms, reportResult } from "@/src/api";
import { Button, Card, DemoBanner, Field, StatusBadge } from "@/src/components/ui";
import { useToast } from "@/src/components/toast";
import { DEMO_MODE, requestSmsPermission, sendOneSms } from "@/src/gateway/nativeSms";
import { makeStyles, spacing, useTheme } from "@/src/theme";

export default function TestSms() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();

  const [mobile, setMobile] = useState("");
  const [message, setMessage] = useState("This is a test SMS from my private gateway.");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<null | { ok: boolean; text: string }>(null);

  async function sendTest() {
    if (!mobile.trim()) {
      toast("Enter a test mobile number", "error");
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const { job } = await createTestSms(mobile.trim(), message.trim());
      if (!DEMO_MODE) {
        const p = await requestSmsPermission();
        if (p !== "granted") {
          await reportResult(job.message_id, { status: "failed", error_message: "Permission denied" });
          setResult({ ok: false, text: "SMS permission denied" });
          setSending(false);
          return;
        }
      }
      try {
        const r = await sendOneSms(job.mobile_number, job.message);
        await reportResult(job.message_id, { status: "sent", simulated: r.simulated });
        setResult({ ok: true, text: `Sent to ${job.mobile_number}${r.simulated ? " (simulated)" : ""}` });
        toast("Test SMS sent", "success");
      } catch (e: any) {
        await reportResult(job.message_id, { status: "failed", error_message: String(e?.message || e) });
        setResult({ ok: false, text: String(e?.message || e) });
        toast("Test SMS failed", "error");
      }
    } catch (e: any) {
      toast(e?.message || "Could not send test", "error");
    } finally {
      setSending(false);
    }
  }

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Text style={styles.title}>Test SMS</Text>
        <Pressable onPress={() => router.back()} hitSlop={8} testID="test-close">
          <X size={24} color={colors.onSurface} />
        </Pressable>
      </View>

      <KeyboardAwareScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl, gap: spacing.lg }}
        bottomOffset={20}
      >
        {DEMO_MODE ? <DemoBanner /> : null}
        <Card>
          <Text style={styles.info}>
            Send one SMS through the same gateway before a bulk run. Only start bulk sending after a successful test.
          </Text>
        </Card>

        <Field
          label="Test mobile number"
          value={mobile}
          onChangeText={setMobile}
          placeholder="9876543210"
          keyboardType="phone-pad"
          testID="test-mobile-input"
        />
        <Field
          label="Test message"
          value={message}
          onChangeText={setMessage}
          placeholder="Type your test message"
          multiline
          numberOfLines={4}
          style={{ minHeight: 100, textAlignVertical: "top" }}
          testID="test-message-input"
        />

        {result ? (
          <Card testID="test-result">
            <View style={styles.resultRow}>
              <StatusBadge kind={result.ok ? "success" : "error"} label={result.ok ? "Sent" : "Failed"} />
            </View>
            <Text style={styles.resultText}>{result.text}</Text>
          </Card>
        ) : null}

        <Button
          label="Send Test SMS"
          icon={<TestTube size={18} color={colors.onBrandPrimary} weight="fill" />}
          onPress={sendTest}
          loading={sending}
          testID="send-test-button"
        />
      </KeyboardAwareScrollView>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  title: { fontSize: 20, fontWeight: "800", color: colors.onSurface },
  info: { fontSize: 14, color: colors.onSurfaceSecondary, lineHeight: 20 },
  resultRow: { flexDirection: "row", marginBottom: spacing.sm },
  resultText: { fontSize: 14, color: colors.onSurface },
}));
