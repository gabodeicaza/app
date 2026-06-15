import React, { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { useAuth } from '@/src/auth-context';
import { ROLE_ESP } from '@/src/utils/roles';
import { colors } from '@/src/theme';

export default function SpecLayout() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/(auth)/login'); return; }
    if (user.role !== ROLE_ESP) {
      router.replace(user.role === 'coordinador_general' ? '/(coord)' : '/(subcoord)');
    }
  }, [user, loading]);

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
