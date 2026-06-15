import React, { useEffect } from 'react';
import { Stack, router } from 'expo-router';
import { useAuth } from '@/src/auth-context';
import { ROLE_SUB } from '@/src/utils/roles';
import { colors } from '@/src/theme';

export default function SubCoordLayout() {
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) { router.replace('/(auth)/login'); return; }
    if (user.role !== ROLE_SUB) {
      router.replace(user.role === 'coordinador_general' ? '/(coord)' : '/(spec)');
    }
  }, [user, loading]);

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}
