import React, { useEffect } from 'react';
import { Tabs, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '@/src/theme';
import { useAuth } from '@/src/auth-context';

export default function EspLayout() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace('/(auth)/login');
    else if (user.role !== 'especialista') router.replace('/(coordinador)');
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
        name="new"
        options={{
          title: 'Nuevo',
          tabBarIcon: ({ color, size }) => <Ionicons name="add-circle" color={color} size={size + 4} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: 'Mensajes',
          tabBarIcon: ({ color, size }) => <Ionicons name="chatbubbles" color={color} size={size} />,
        }}
      />

      {/* Pantallas sin pestaña */}
      <Tabs.Screen name="profile" options={{ href: null }} />
      <Tabs.Screen name="calendar" options={{ href: null }} />
      <Tabs.Screen name="report/[id]" options={{ href: null }} />
      <Tabs.Screen name="chat/directos" options={{ href: null }} />
      <Tabs.Screen name="chat/areas" options={{ href: null }} />
      <Tabs.Screen name="chat/[peerId]" options={{ href: null }} />
      <Tabs.Screen name="chat/area/[areaId]" options={{ href: null }} />
    </Tabs>
  );
}
