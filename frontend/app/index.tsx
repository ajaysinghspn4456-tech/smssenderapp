import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";

import { setupGateway, getStoredToken } from "@/src/api";
import { Button } from "@/src/components/ui";
import { makeStyles, useTheme } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import { TOKEN_KEY } from "@/src/api";

export default function Index() {
  const router = useRouter();
  const styles = useStyles();
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);

  async function bootstrap() {
    setError(null);
    try {
      let token = await getStoredToken();
      if (!token) {
        const res = await setupGateway();
        if (res.token) {
          await storage.secureSet(TOKEN_KEY, res.token);
          token = res.token;
        }
      }
      if (!token) {
        setError("Gateway already initialized on server but this device has no token. Reset the backend or restore the token.");
        return;
      }
      router.replace("/(tabs)");
    } catch (e: any) {
      setError(e?.message || "Could not reach the gateway backend.");
    }
  }

  useEffect(() => {
    bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container} testID="bootstrap-screen">
      <Image
        source={require("../assets/images/uppcl-logo-crop.png")}
        style={styles.logo}
        contentFit="contain"
      />
      <Text style={styles.title}>UPPCL Suchna Seva</Text>
      {error ? (
        <>
          <Text style={styles.error}>{error}</Text>
          <Button label="Retry" onPress={bootstrap} testID="bootstrap-retry" style={{ marginTop: 16 }} />
        </>
      ) : (
        <ActivityIndicator color={colors.brandPrimary} style={{ marginTop: 20 }} />
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.surface, alignItems: "center", justifyContent: "center", padding: 32 },
  logo: { width: 180, height: 150, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: "800", color: colors.onSurface },
  error: { fontSize: 14, color: colors.error, textAlign: "center", marginTop: 16, lineHeight: 20 },
}));
