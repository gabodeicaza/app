import React from 'react';
import { View, ActivityIndicator, StyleSheet, Image } from 'react-native';
import { Redirect } from 'expo-router';
import { useAuth } from '@/src/auth-context';
import { colors } from '@/src/theme';

export default function Index() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View style={styles.container}>
        <Image source={require('../assets/images/dirac-logo.png')} style={styles.logo} resizeMode="contain" />
        <ActivityIndicator color={colors.primary} size="large" style={{ marginTop: 24 }} />
      </View>
    );
  }

  if (!user) return <Redirect href="/(auth)/login" />;
  if (user.role === 'coordinador') return <Redirect href="/(coordinador)" />;
  return <Redirect href="/(especialista)" />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: { width: 140, height: 140 },
});
