import { Tabs } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { House, UploadSimple, ClockCounterClockwise, GearSix } from "phosphor-react-native";

import { heartbeat } from "@/src/api";
import { DEMO_MODE, getSimCards } from "@/src/gateway/nativeSms";
import { useTheme } from "@/src/theme";

function useHeartbeat() {
  useEffect(() => {
    let active = true;
    async function beat() {
      let simAvailable = DEMO_MODE; // demo: pretend a SIM is present
      if (!DEMO_MODE) {
        const sims = await getSimCards();
        simAvailable = sims.length > 0;
      }
      try {
        await heartbeat(simAvailable, true);
      } catch {
        // offline / not set up yet — ignore
      }
    }
    beat();
    const id = setInterval(() => {
      if (active) beat();
    }, 15000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);
}

export default function TabsLayout() {
  const { colors } = useTheme();
  useHeartbeat();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: {
          backgroundColor: colors.surfaceSecondary,
          borderTopColor: colors.border,
          ...(Platform.OS === "web" ? { height: 64 } : {}),
        },
        tabBarItemStyle: { alignSelf: "center" },
        tabBarLabelStyle: { fontSize: 11, fontWeight: "600" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Dashboard",
          tabBarIcon: ({ color, focused }) => (
            <House size={24} color={color} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
      <Tabs.Screen
        name="upload"
        options={{
          title: "Upload",
          tabBarIcon: ({ color, focused }) => (
            <UploadSimple size={24} color={color} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
      <Tabs.Screen
        name="history"
        options={{
          title: "History",
          tabBarIcon: ({ color, focused }) => (
            <ClockCounterClockwise size={24} color={color} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, focused }) => (
            <GearSix size={24} color={color} weight={focused ? "fill" : "regular"} />
          ),
        }}
      />
    </Tabs>
  );
}
