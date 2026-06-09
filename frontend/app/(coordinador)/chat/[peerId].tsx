import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { ChatConversationScreen } from '@/src/components/ChatConversation';

export default function CoordChatConversation() {
  const { peerId } = useLocalSearchParams<{ peerId: string }>();
  return <ChatConversationScreen peerId={String(peerId)} />;
}
