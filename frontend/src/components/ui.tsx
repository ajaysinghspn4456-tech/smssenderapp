// Shared UI primitives for the SMS Gateway app.
import * as Haptics from "expo-haptics";
import { ReactNode, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  TextInputProps,
  View,
} from "react-native";
import { CaretDown, Check, Warning, X } from "phosphor-react-native";

import { makeStyles, radius, spacing, useTheme } from "@/src/theme";

// ---------------------------------------------------------------------------
export function Button({
  label,
  onPress,
  variant = "primary",
  disabled,
  loading,
  icon,
  testID,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  testID?: string;
  style?: any;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const bg =
    variant === "primary"
      ? colors.brandPrimary
      : variant === "danger"
        ? colors.error
        : variant === "secondary"
          ? colors.surfaceTertiary
          : "transparent";
  const fg =
    variant === "primary"
      ? colors.onBrandPrimary
      : variant === "danger"
        ? colors.onError
        : colors.onSurface;
  return (
    <Pressable
      testID={testID}
      disabled={disabled || loading}
      onPress={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
        onPress();
      }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg },
        variant === "ghost" && { paddingVertical: spacing.sm },
        (disabled || loading) && { opacity: 0.5 },
        pressed && { opacity: 0.85 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.btnInner}>
          {icon}
          <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
export function Card({ children, style, testID }: { children: ReactNode; style?: any; testID?: string }) {
  const styles = useStyles();
  return (
    <View testID={testID} style={[styles.card, style]}>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
export type StatusKind = "success" | "error" | "warning" | "muted";

export function StatusBadge({ label, kind, testID }: { label: string; kind: StatusKind; testID?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const map = {
    success: colors.success,
    error: colors.error,
    warning: colors.warning,
    muted: colors.muted,
  } as const;
  const c = map[kind];
  return (
    <View testID={testID} style={[styles.badge, { backgroundColor: c + "1A", borderColor: c + "40" }]}>
      <View style={[styles.dot, { backgroundColor: c }]} />
      <Text style={[styles.badgeText, { color: c }]}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
export function StatCard({
  label,
  value,
  kind,
  testID,
}: {
  label: string;
  value: string | number;
  kind?: StatusKind;
  testID?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  const color =
    kind === "success"
      ? colors.success
      : kind === "error"
        ? colors.error
        : kind === "warning"
          ? colors.warning
          : colors.brandPrimary;
  return (
    <View testID={testID} style={[styles.statCard, { backgroundColor: color + "12", borderColor: color + "33" }]}>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
export function ScreenHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.header}>
      <View style={{ flex: 1 }}>
        <Text style={styles.headerTitle}>{title}</Text>
        {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

// ---------------------------------------------------------------------------
export function Field(props: TextInputProps & { label?: string }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { label, style, ...rest } = props;
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <TextInput
        placeholderTextColor={colors.muted}
        style={[styles.input, style]}
        {...rest}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
export function Dropdown({
  label,
  value,
  options,
  onSelect,
  placeholder = "Select",
  testID,
}: {
  label?: string;
  value: string | null;
  options: string[];
  onSelect: (v: string) => void;
  placeholder?: string;
  testID?: string;
}) {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <DropdownInner
        value={value}
        options={options}
        onSelect={onSelect}
        placeholder={placeholder}
        testID={testID}
        styles={styles}
        colors={colors}
      />
    </View>
  );
}

function DropdownInner({ value, options, onSelect, placeholder, testID, styles, colors }: any) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        testID={testID}
        style={styles.dropdown}
        onPress={() => {
          Haptics.selectionAsync().catch(() => {});
          setOpen(true);
        }}
      >
        <Text style={[styles.dropdownText, !value && { color: colors.muted }]} numberOfLines={1}>
          {value || placeholder}
        </Text>
        <CaretDown size={16} color={colors.muted} weight="bold" />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setOpen(false)}>
          <View style={styles.dropdownSheet}>
            <ScrollView>
              {options.map((opt: string) => (
                <Pressable
                  key={opt}
                  testID={`dropdown-option-${opt}`}
                  style={styles.dropdownOption}
                  onPress={() => {
                    onSelect(opt);
                    setOpen(false);
                  }}
                >
                  <Text style={styles.dropdownOptionText} numberOfLines={1}>
                    {opt}
                  </Text>
                  {value === opt ? <Check size={16} color={colors.brandPrimary} weight="bold" /> : null}
                </Pressable>
              ))}
              {options.length === 0 ? (
                <Text style={[styles.dropdownOptionText, { padding: spacing.lg, color: colors.muted }]}>
                  No options
                </Text>
              ) : null}
            </ScrollView>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const styles = useStyles();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onCancel}>
      <Pressable style={styles.modalBackdrop} onPress={onCancel}>
        <Pressable style={styles.confirmSheet} onPress={() => {}}>
          <Text style={styles.confirmTitle}>{title}</Text>
          <Text style={styles.confirmMessage}>{message}</Text>
          <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
            <Button
              label={confirmLabel}
              variant={danger ? "danger" : "primary"}
              onPress={onConfirm}
              testID="confirm-sheet-confirm"
            />
            <Button label={cancelLabel} variant="secondary" onPress={onCancel} testID="confirm-sheet-cancel" />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function EmptyState({ title, subtitle, icon }: { title: string; subtitle?: string; icon?: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.empty}>
      {icon}
      <Text style={styles.emptyTitle}>{title}</Text>
      {subtitle ? <Text style={styles.emptySubtitle}>{subtitle}</Text> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
export function DemoBanner() {
  const styles = useStyles();
  const { colors } = useTheme();
  return (
    <View style={styles.demoBanner} testID="demo-banner">
      <Warning size={16} color={colors.onWarning} weight="fill" />
      <Text style={styles.demoText}>
        Demo mode — real SMS sending needs an Android build. Sends here are simulated.
      </Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
export function Row({ children, style }: { children: ReactNode; style?: any }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: spacing.sm }, style]}>{children}</View>;
}

export { X };

const useStyles = makeStyles((colors) => ({
  button: {
    borderRadius: radius.md,
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 48,
  },
  btnInner: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  buttonText: { fontSize: 15, fontWeight: "700" },
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  badgeText: { fontSize: 12, fontWeight: "700" },
  statCard: {
    flex: 1,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "flex-start",
    gap: 2,
  },
  statValue: { fontSize: 28, fontWeight: "800" },
  statLabel: { fontSize: 13, color: colors.muted, fontWeight: "600" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  headerTitle: { fontSize: 24, fontWeight: "800", color: colors.onSurface },
  headerSubtitle: { fontSize: 13, color: colors.muted, marginTop: 2 },
  fieldLabel: { fontSize: 13, fontWeight: "700", color: colors.onSurfaceSecondary },
  input: {
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.onSurface,
    minHeight: 48,
  },
  dropdown: {
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  dropdownText: { fontSize: 15, color: colors.onSurface, flex: 1, fontWeight: "600" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "#00000066",
    justifyContent: "center",
    padding: spacing.lg,
  },
  dropdownSheet: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    maxHeight: "60%",
    paddingVertical: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dropdownOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    gap: spacing.sm,
  },
  dropdownOptionText: { fontSize: 15, color: colors.onSurface, flex: 1 },
  confirmSheet: {
    marginTop: "auto",
    backgroundColor: colors.surfaceSecondary,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.xl,
    marginHorizontal: -spacing.lg,
    marginBottom: -spacing.lg,
  },
  confirmTitle: { fontSize: 19, fontWeight: "800", color: colors.onSurface },
  confirmMessage: { fontSize: 15, color: colors.onSurfaceSecondary, marginTop: spacing.sm, lineHeight: 21 },
  empty: { alignItems: "center", justifyContent: "center", padding: spacing["2xl"], gap: spacing.sm },
  emptyTitle: { fontSize: 17, fontWeight: "700", color: colors.onSurface, textAlign: "center" },
  emptySubtitle: { fontSize: 14, color: colors.muted, textAlign: "center", lineHeight: 20 },
  demoBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.warning,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  demoText: { flex: 1, color: colors.onWarning, fontSize: 12.5, fontWeight: "600", lineHeight: 17 },
}));
