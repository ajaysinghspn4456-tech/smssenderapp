import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ArrowLeft, CheckSquare, Square } from "phosphor-react-native";

import { createBatch, validateFile } from "@/src/api";
import { Button, ConfirmSheet } from "@/src/components/ui";
import { useToast } from "@/src/components/toast";
import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

export default function Preview() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const toast = useToast();
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    file_id: string;
    sheet: string;
    mobile_column: string;
    message_column: string;
    country_code: string;
  }>();

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [initDone, setInitDone] = useState(false);
  const [confirm, setConfirm] = useState<null | "all" | "selected">(null);
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["validate", params.file_id, params.sheet, params.mobile_column, params.message_column],
    queryFn: () =>
      validateFile({
        file_id: params.file_id!,
        sheet: params.sheet!,
        mobile_column: params.mobile_column!,
        message_column: params.message_column!,
        country_code: params.country_code || "+91",
      }),
  });

  const validRows = useMemo(() => data?.rows.filter((r) => r.status === "valid") ?? [], [data]);

  if (data && !initDone) {
    setSelected(new Set(validRows.map((r) => r.row)));
    setInitDone(true);
  }

  function toggle(row: number) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(row)) n.delete(row);
      else n.add(row);
      return n;
    });
  }

  async function start(mode: "all" | "selected") {
    setConfirm(null);
    setCreating(true);
    try {
      const rows = mode === "all" ? undefined : Array.from(selected);
      const res = await createBatch({
        file_id: params.file_id!,
        sheet: params.sheet!,
        mobile_column: params.mobile_column!,
        message_column: params.message_column!,
        country_code: params.country_code || "+91",
        selected_rows: rows,
      });
      router.replace({ pathname: "/batch/[id]", params: { id: res.batch_id } });
    } catch (e: any) {
      toast(e?.message || "Could not start sending", "error");
    } finally {
      setCreating(false);
    }
  }

  const selectedCount = selected.size;

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable onPress={() => router.back()} hitSlop={8} testID="preview-back">
          <ArrowLeft size={24} color={colors.onSurface} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>Message preview</Text>
          <Text style={styles.subtitle}>{validRows.length} ready · {selectedCount} selected</Text>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.brandPrimary} />
        </View>
      ) : (
        <FlatList
          data={validRows}
          keyExtractor={(r) => String(r.row)}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const checked = selected.has(item.row);
            return (
              <Pressable style={styles.row} onPress={() => toggle(item.row)} testID={`preview-row-${item.row}`}>
                {checked ? (
                  <CheckSquare size={22} color={colors.brandPrimary} weight="fill" />
                ) : (
                  <Square size={22} color={colors.muted} />
                )}
                <Text style={styles.rowNum}>{item.row}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowMobile}>{item.mobile}</Text>
                  <Text style={styles.rowMessage} numberOfLines={2}>
                    {item.message}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Button
          label={`Send All (${validRows.length})`}
          onPress={() => setConfirm("all")}
          loading={creating}
          disabled={validRows.length === 0}
          testID="send-all-button"
        />
        <Button
          label={`Send Selected (${selectedCount})`}
          variant="secondary"
          onPress={() => setConfirm("selected")}
          disabled={selectedCount === 0 || creating}
          testID="send-selected-button"
        />
      </View>

      <ConfirmSheet
        visible={confirm !== null}
        title="Start sending?"
        message={`You are about to send ${confirm === "all" ? validRows.length : selectedCount} SMS. Continue?`}
        confirmLabel="Start Sending"
        onConfirm={() => start(confirm!)}
        onCancel={() => setConfirm(null)}
      />
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
  subtitle: { fontSize: 13, color: colors.muted, marginTop: 2 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { padding: spacing.lg, gap: spacing.sm },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowNum: { fontSize: 12, color: colors.muted, fontWeight: "700", width: 28 },
  rowMobile: { fontSize: 15, fontWeight: "700", color: colors.onSurface },
  rowMessage: { fontSize: 13, color: colors.onSurfaceTertiary, marginTop: 2, lineHeight: 18 },
  footer: {
    padding: spacing.lg,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
}));
