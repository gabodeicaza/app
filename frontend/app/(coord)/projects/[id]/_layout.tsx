import React from 'react';
import { Stack } from 'expo-router';
import { colors } from '@/src/theme';

export default function ProjectLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="tree" />
    </Stack>
  );
}
