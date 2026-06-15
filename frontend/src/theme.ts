// SyncSite — Royal Blue & White design tokens.
export const colors = {
  primary: '#1E40AF',
  primaryDark: '#1E3A8A',
  primaryLight: '#DBEAFE',
  bg: '#F8FAFC',
  surface: '#FFFFFF',
  border: '#E2E8F0',
  borderStrong: '#CBD5E1',
  text: '#0F172A',
  textBody: '#334155',
  textMuted: '#64748B',
  textInverse: '#FFFFFF',
  online: '#10B981',
  offline: '#94A3B8',
  syncing: '#F59E0B',
  error: '#EF4444',
  errorBg: '#FEE2E2',
  warning: '#F59E0B',
  warningBg: '#FEF3C7',
  success: '#10B981',
  successBg: '#D1FAE5',
  black: '#000000',
  overlay: 'rgba(0,0,0,0.6)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = { sm: 6, md: 10, lg: 14, full: 999 };

export const shadow = {
  card: {
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
};

// Helpers to color area chips consistently when an area lacks a color.
export function areaTone(hex?: string) {
  const c = hex || colors.primary;
  return { bg: c + '22', border: c + '55', text: c };
}
