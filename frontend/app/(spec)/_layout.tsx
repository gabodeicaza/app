// SynCo v2.0 — Layout del Especialista con Bottom Tabs.
// Replica el patrón de la imagen objetivo: Noticias · Inicio · Nuevo · Mensajes · Calendario.
import React, { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Tabs, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/src/auth-context';
import { ROLE_ESP } from '@/src/utils/roles';
import { colors, radius } from '@/src/theme';

export default function SpecLayout() {
  const { user, loading } = useAuth();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/(auth)/login'); return; }
    if (user.role !== ROLE_ESP) {
      router.replace(user.role === 'coordinador_general' ? '/(coord)' : '/(subcoord)');
    }
  }, [user, loading]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: [
          styles.tabBar,
          { height: 60 + (insets.bottom > 0 ? insets.bottom : 8), paddingBottom: insets.bottom > 0 ? insets.bottom : 8 },
        ],
        tabBarLabelStyle: styles.tabLabel,
        tabBarItemStyle: { paddingVertical: 4 },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="noticias"
        options={{
          title: 'Noticias',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="newspaper-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Inicio',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="home" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="nuevo"
        options={{
          title: 'Nuevo',
          tabBarIcon: ({ focused }) => (
            <View style={[styles.fab, focused && styles.fabActive]}>
              <Ionicons name="add" size={26} color={colors.textInverse} />
            </View>
          ),
          tabBarLabelStyle: [styles.tabLabel, { marginTop: 2 }],
        }}
      />
      <Tabs.Screen
        name="mensajes"
        options={{
          title: 'Mensajes',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="calendario"
        options={{
          title: 'Calendario',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    paddingTop: 6,
    ...Platform.select({
      ios: {
        shadowColor: '#0F172A',
        shadowOpacity: 0.08,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: -2 },
      },
      android: { elevation: 12 },
      default: {},
    }),
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2,
  },
  fab: {
    width: 48,
    height: 48,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -10,
    ...Platform.select({
      ios: {
        shadowColor: colors.primary,
        shadowOpacity: 0.35,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 4 },
      },
      android: { elevation: 6 },
      default: {},
    }),
  },
  fabActive: {
    backgroundColor: colors.primaryDark,
  },
});
