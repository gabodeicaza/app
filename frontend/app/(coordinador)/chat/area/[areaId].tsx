import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ChatAreaConversationScreen } from '@/src/components/ChatAreaConversation';
export default function CoordAreaConv() {
  const { areaId } = useLocalSearchParams<{ areaId: string }>();
  return <ChatAreaConversationScreen areaId={String(areaId)} />;
}
