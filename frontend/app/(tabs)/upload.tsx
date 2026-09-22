import * as DocumentPicker from "expo-document-picker";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FileArrowUp, CheckCircle, WarningCircle, Table } from "phosphor-react-native";

import {
  ColumnsResult,
  UploadResult,
  ValidationResult,
  getColumns,
  getSettings,
  uploadFile,
  validateFile,
} from "@/src/api";
import { Button, Card, Dropdown, EmptyState } from "@/src/components/ui";
import { useToast } from "@/src/components/toast";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

function guessColumn(columns: string[], keywords: string[]): string | null {
  for (const c of columns) {
    const l = c.toLowerCase();
    if (keywords.some((k) => l.includes(k))) return c;
  }
  return null;
}

export default function UploadScreen() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();

  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettings });
  const countryCode = settings?.default_country_code ?? "+91";

  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<UploadResult | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [cols, setCols] = useState<ColumnsResult | null>(null);
  const [mobileCol, setMobileCol] = useState<string | null>(null);
  const [messageCol, setMessageCol] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [invalidView, setInvalidView] = useState(false);

  async function pickFile() {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: "*/*", copyToCacheDirectory: true });
      if (res.canceled) return;
      const asset = res.assets[0];
      const name = asset.name || "upload";
      if (!/\.(xlsx|xls|csv)$/i.test(name)) {
        toast("Please select an .xlsx, .xls or .csv file", "error");
        return;
      }
      setBusy(true);
      setValidation(null);
      const up = await uploadFile({ uri: asset.uri, name, mimeType: asset.mimeType, file: (asset as any).file });
      setFile(up);
      const firstSheet = up.sheets[0];
      setSheet(firstSheet);
      await loadColumns(up.file_id, firstSheet);
    } catch (e: any) {
      toast(e?.message || "Upload failed", "error");
    } finally {
      setBusy(false);
    }
  }

  async function loadColumns(fileId: string, sheetName: string) {
    setBusy(true);
    try {
      const c = await getColumns(fileId, sheetName);
      setCols(c);
      setMobileCol(guessColumn(c.columns, ["mobile", "phone", "number", "contact", "msisdn", "cell"]));
      setMessageCol(guessColumn(c.columns, ["message", "msg", "text", "sms", "body", "content"]));
      setValidation(null);
    } finally {
      setBusy(false);
    }
  }

  async function onSheetChange(s: string) {
    if (!file) return;
    setSheet(s);
    await loadColumns(file.file_id, s);
  }

  async function runValidation() {
    if (!file || !mobileCol || !messageCol) {
      toast("Select both mobile and message columns", "error");
      return;
    }
    setBusy(true);
    try {
      const v = await validateFile({
        file_id: file.file_id,
        sheet,
        mobile_column: mobileCol,
        message_column: messageCol,
        country_code: countryCode,
      });
      setValidation(v);
    } catch (e: any) {
      toast(e?.message || "Validation failed", "error");
    } finally {
      setBusy(false);
    }
  }

  function goToPreview() {
    if (!file || !mobileCol || !messageCol) return;
    router.push({
      pathname: "/preview",
      params: {
        file_id: file.file_id,
        sheet,
        mobile_column: mobileCol,
        message_column: messageCol,
        country_code: countryCode,
      },
    });
  }

  const invalidRows = validation?.rows.filter((r) => r.status !== "valid") ?? [];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ paddingTop: insets.top + spacing.md, paddingBottom: spacing["2xl"] }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Upload Excel</Text>
      <Text style={styles.subtitle}>Excel / CSV se numbers aur messages upload karein</Text>

      {/* Step 1: pick */}
      <View style={styles.body}>
        <Pressable style={styles.dropzone} onPress={pickFile} testID="pick-file-button">
          <View style={styles.dropIcon}>
            <FileArrowUp size={28} color={colors.brandPrimary} weight="bold" />
          </View>
          <Text style={styles.dropTitle}>{file ? file.filename : "Select a file"}</Text>
          <Text style={styles.dropSub}>.xlsx · .xls · .csv</Text>
        </Pressable>

        {busy ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.brandPrimary} />
            <Text style={styles.loadingText}>Working...</Text>
          </View>
        ) : null}

        {/* Step 2: mapping */}
        {cols ? (
          <Card testID="mapping-card">
            <Text style={styles.cardTitle}>Map your columns</Text>
            {file && file.sheets.length > 1 ? (
              <Dropdown
                label="Sheet"
                value={sheet}
                options={file.sheets}
                onSelect={onSheetChange}
                testID="sheet-dropdown"
              />
            ) : null}
            <View style={{ height: spacing.md }} />
            <Dropdown
              label="Mobile Number column"
              value={mobileCol}
              options={cols.columns}
              onSelect={setMobileCol}
              testID="mobile-column-dropdown"
            />
            <View style={{ height: spacing.md }} />
            <Dropdown
              label="Message column"
              value={messageCol}
              options={cols.columns}
              onSelect={setMessageCol}
              testID="message-column-dropdown"
            />
            <Text style={styles.hint}>{cols.total_rows} rows · country code {countryCode}</Text>
            <Button label="Validate rows" onPress={runValidation} testID="validate-button" style={{ marginTop: spacing.md }} />
          </Card>
        ) : null}

        {/* Preview first rows */}
        {cols && !validation ? (
          <Card>
            <View style={styles.rowBetween}>
              <Text style={styles.cardTitle}>Preview (first {cols.preview.length})</Text>
              <Table size={18} color={colors.muted} />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View>
                <View style={styles.thead}>
                  {cols.columns.map((c) => (
                    <Text key={c} style={styles.th} numberOfLines={1}>
                      {c}
                    </Text>
                  ))}
                </View>
                {cols.preview.slice(0, 8).map((r, i) => (
                  <View key={i} style={styles.trow}>
                    {cols.columns.map((c) => (
                      <Text key={c} style={styles.td} numberOfLines={1}>
                        {r[c]}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          </Card>
        ) : null}

        {/* Step 3: validation summary */}
        {validation ? (
          <Card testID="validation-card">
            <Text style={styles.cardTitle}>Validation summary</Text>
            <View style={styles.summaryGrid}>
              <SummaryPill label="Total" value={validation.summary.total} color={colors.onSurface} />
              <SummaryPill label="Valid" value={validation.summary.valid} color={colors.success} />
              <SummaryPill label="Invalid" value={validation.summary.invalid} color={colors.error} />
              <SummaryPill label="Duplicate" value={validation.summary.duplicate} color={colors.warning} />
              <SummaryPill label="Empty" value={validation.summary.empty} color={colors.muted} />
            </View>

            {invalidRows.length > 0 ? (
              <Pressable
                style={styles.viewInvalid}
                onPress={() => setInvalidView((v) => !v)}
                testID="toggle-invalid-rows"
              >
                <WarningCircle size={16} color={colors.warning} weight="fill" />
                <Text style={styles.viewInvalidText}>
                  {invalidView ? "Hide" : "View"} {invalidRows.length} problem rows
                </Text>
              </Pressable>
            ) : null}

            {invalidView ? (
              <View style={styles.invalidList}>
                {invalidRows.slice(0, 50).map((r) => (
                  <View key={r.row} style={styles.invalidRow}>
                    <Text style={styles.invalidRowNum}>#{r.row}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.invalidMobile}>{r.raw_mobile || "(empty)"}</Text>
                      <Text style={styles.invalidIssue}>{r.status.toUpperCase()} · {r.issues.join(", ")}</Text>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}

            <Button
              label={`Preview & Send (${validation.summary.valid})`}
              onPress={goToPreview}
              disabled={validation.summary.valid === 0}
              icon={<CheckCircle size={18} color={colors.onBrandPrimary} weight="fill" />}
              testID="preview-send-button"
              style={{ marginTop: spacing.lg }}
            />
          </Card>
        ) : null}

        {!file && !busy ? (
          <View style={styles.emptyWrap}>
            <Image
              source={{ uri: "https://images.pexels.com/photos/95916/pexels-photo-95916.jpeg?auto=compress&cs=tinysrgb&dpr=2&h=650&w=940" }}
              style={styles.emptyImg}
            />
            <EmptyState title="Select an Excel or CSV file to begin" subtitle="Har row = ek SMS. Numbers aur messages alag columns me rakhein." />
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

function SummaryPill({ label, value, color }: { label: string; value: number; color: string }) {
  const styles = useStyles();
  return (
    <View style={styles.summaryPill}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  screen: { flex: 1, backgroundColor: colors.surface },
  title: { fontSize: 24, fontWeight: "800", color: colors.onSurface, paddingHorizontal: spacing.lg },
  subtitle: { fontSize: 13, color: colors.muted, paddingHorizontal: spacing.lg, marginTop: 2 },
  body: { padding: spacing.lg, gap: spacing.lg },
  dropzone: {
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.borderStrong,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: "center",
    gap: 6,
    backgroundColor: colors.surfaceSecondary,
  },
  dropIcon: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: colors.brandTertiary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 4,
  },
  dropTitle: { fontSize: 16, fontWeight: "700", color: colors.onSurface },
  dropSub: { fontSize: 13, color: colors.muted },
  loading: { flexDirection: "row", alignItems: "center", gap: spacing.sm, justifyContent: "center" },
  loadingText: { color: colors.muted },
  cardTitle: { fontSize: 16, fontWeight: "800", color: colors.onSurface, marginBottom: spacing.md },
  hint: { fontSize: 12, color: colors.muted, marginTop: spacing.md },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  thead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 6 },
  th: { width: 130, fontSize: 12, fontWeight: "800", color: colors.onSurfaceSecondary, paddingRight: spacing.sm },
  trow: { flexDirection: "row", paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.divider },
  td: { width: 130, fontSize: 12.5, color: colors.onSurfaceTertiary, paddingRight: spacing.sm },
  summaryGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  summaryPill: {
    minWidth: 92,
    flexGrow: 1,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
    alignItems: "center",
  },
  summaryValue: { fontSize: 22, fontWeight: "800" },
  summaryLabel: { fontSize: 12, color: colors.muted, fontWeight: "600" },
  viewInvalid: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: spacing.md },
  viewInvalidText: { color: colors.warning, fontWeight: "700", fontSize: 14 },
  invalidList: { marginTop: spacing.sm, gap: spacing.xs },
  invalidRow: {
    flexDirection: "row",
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.divider,
  },
  invalidRowNum: { fontSize: 13, color: colors.muted, fontWeight: "700", width: 40 },
  invalidMobile: { fontSize: 14, color: colors.onSurface, fontWeight: "600" },
  invalidIssue: { fontSize: 12, color: colors.error, marginTop: 2 },
  emptyWrap: { alignItems: "center", gap: spacing.md },
  emptyImg: { width: "100%", height: 160, borderRadius: radius.lg, opacity: 0.9 },
}));
