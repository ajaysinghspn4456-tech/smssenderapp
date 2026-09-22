// Lightweight toast system (no Alert usage anywhere in the app).
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { makeStyles, useTheme } from "@/src/theme";

type ToastKind = "success" | "error" | "info";
type ToastItem = { id: number; text: string; kind: ToastKind };

const ToastContext = createContext<(text: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const { colors } = useTheme();
  const counter = useRef(0);

  const show = useCallback(
    (text: string, kind: ToastKind = "info") => {
      counter.current += 1;
      setToast({ id: counter.current, text, kind });
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      setTimeout(() => {
        Animated.timing(opacity, { toValue: 0, duration: 220, useNativeDriver: true }).start(
          () => setToast(null),
        );
      }, 2600);
    },
    [opacity],
  );

  const bg =
    toast?.kind === "success"
      ? colors.success
      : toast?.kind === "error"
        ? colors.error
        : colors.surfaceInverse;

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast ? (
        <Animated.View
          pointerEvents="none"
          testID="toast"
          style={[styles.toast, { top: insets.top + 12, opacity, backgroundColor: bg }]}
        >
          <Text style={styles.toastText}>{toast.text}</Text>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

const useStyles = makeStyles((colors) => ({
  toast: {
    position: "absolute",
    left: 16,
    right: 16,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    zIndex: 9999,
    ...StyleSheet.flatten({
      shadowColor: "#000",
      shadowOpacity: 0.18,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    }),
  },
  toastText: {
    color: colors.onSurfaceInverse,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
}));
