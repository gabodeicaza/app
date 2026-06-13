import React, { useEffect } from 'react';
import { Tabs, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/src/theme';
import { useAuth } from '@/src/auth-context';
import { isSupervisorView } from '@/src/utils/roles';

export default function CoordLayout() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/(auth)/login');
    else if (!isSupervisorView(user.role)) router.replace('/(especialista)');
  }, [user, loading]);

  return (
    <Tabs
      initialRouteName="index"
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          height: 64,
          paddingTop: 6,
          paddingBottom: 8,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="noticias"
        options={{
          title: 'Noticias',
          tabBarIcon: ({ color, size }) => <Ionicons name="newspaper" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="index"
        options={{
          title: 'Inicio',
          tabBarIcon: ({ color, size }) => <Ionicons name="home" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="summary"
        options={{
          title: 'Resumen IA',
          tabBarIcon: ({ color, size }) => <Ionicons name="sparkles" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Mensajes',
          tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Configuración',
          tabBarIcon: ({ color, size }) => <Ionicons name="settings" color={color} size={size} />,
        }}
      />

      {/* Pantallas accesibles pero sin pestaña */}
      <Tabs.Screen name="profile" options={{ href: null }} />
      <Tabs.Screen name="areas" options={{ href: null }} />
      <Tabs.Screen name="calendar" options={{ href: null }} />
      <Tabs.Screen name="report/[id]" options={{ href: null }} />
      <Tabs.Screen name="settings/proyecto" options={{ href: null }} />
      <Tabs.Screen name="settings/puntos" options={{ href: null }} />
      <Tabs.Screen name="chat/directos" options={{ href: null }} />
      <Tabs.Screen name="chat/areas" options={{ href: null }} />
      <Tabs.Screen name="chat/[peerId]" options={{ href: null }} />
      <Tabs.Screen name="chat/area/[areaId]" options={{ href: null }} />
    </Tabs>
  );
}
