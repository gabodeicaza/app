import React, { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { useAuth } from '@/src/auth-context';
import { ROLE_COORD } from '@/src/utils/roles';
import { colors } from '@/src/theme';

export default function CoordLayout() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/(auth)/login'); return; }
    if (user.role !== ROLE_COORD) {
      router.replace(user.role === 'sub_coordinador' ? '/(subcoord)' : '/(spec)');
    }
  }, [user, loading]);

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="projects/new" options={{ presentation: 'modal' }} />
      <Stack.Screen name="projects/[id]" />
    </Stack>
  );
}
