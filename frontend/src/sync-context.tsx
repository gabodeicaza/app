import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { storage } from '@/src/utils/storage';
import { api } from '@/src/api';

export interface QueuedReport {
  localId: string;
  title: string;
  comments: string;
  area: string;
  areaName?: string;
  images: string[];
  location?: string | null;
  // Smart-report fields (optional for backward compatibility)
  reference_point_id?: string | null;
  reference_point_name?: string | null;
  coordinates?: string | null;
  first_reading?: number | null;
  last_reading?: number | null;
  unit?: string | null;
  activities?: string | null;
  personnel?: string[];
  equipment?: string[];
  priority?: 1 | 2 | 3;
  createdAt: string; // ISO
  status: 'pending' | 'syncing' | 'error';
  error?: string;
}

interface Ctx {
  online: boolean;
  queue: QueuedReport[];
  pendingCount: number;
  enqueue: (r: Omit<QueuedReport, 'localId' | 'createdAt' | 'status'>) => Promise<void>;
  syncNow: () => Promise<void>;
  syncing: boolean;
}

const SyncCtx = createContext<Ctx | null>(null);
const QUEUE_KEY = 'syncsite_queue';

async function loadQueue(): Promise<QueuedReport[]> {
  const raw = await storage.getItem<string>(QUEUE_KEY, '');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
async function saveQueue(q: QueuedReport[]): Promise<void> {
  await storage.setItem(QUEUE_KEY, JSON.stringify(q));
}

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [online, setOnline] = useState(true);
  const [queue, setQueue] = useState<QueuedReport[]>([]);
  const [syncing, setSyncing] = useState(false);
  const syncingRef = useRef(false);

  // Load queue once
  useEffect(() => {
    loadQueue().then(setQueue);
  }, []);

  // Net status
  useEffect(() => {
    const handler = (s: NetInfoState) => {
      const isOnline = !!(s.isConnected && s.isInternetReachable !== false);
      setOnline(isOnline);
    };
    NetInfo.fetch().then(handler);
    const unsub = NetInfo.addEventListener(handler);
    return () => unsub();
  }, []);

  const enqueue = useCallback(async (r: Omit<QueuedReport, 'localId' | 'createdAt' | 'status'>) => {
    const item: QueuedReport = {
      ...r,
      localId: 'LOCAL-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    const next = [item, ...(await loadQueue())];
    await saveQueue(next);
    setQueue(next);
  }, []);

  const syncNow = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      let current = await loadQueue();
      const pending = current.filter((q) => q.status !== 'syncing');
      for (const item of pending) {
        // mark syncing
        current = current.map((q) => (q.localId === item.localId ? { ...q, status: 'syncing' as const } : q));
        await saveQueue(current);
        setQueue(current);
        try {
          await api.createReport({
            title: item.title,
            comments: item.comments,
            area: item.area,
            images: item.images,
            location: item.location,
            reference_point_id: item.reference_point_id ?? undefined,
            reference_point_name: item.reference_point_name ?? undefined,
            coordinates: item.coordinates ?? undefined,
            first_reading: item.first_reading ?? undefined,
            last_reading: item.last_reading ?? undefined,
            unit: item.unit ?? undefined,
            activities: item.activities ?? undefined,
            personnel: item.personnel,
            equipment: item.equipment,
            priority: item.priority,
          });
          current = current.filter((q) => q.localId !== item.localId);
          await saveQueue(current);
          setQueue(current);
        } catch (e: any) {
          current = current.map((q) =>
            q.localId === item.localId ? { ...q, status: 'error' as const, error: e?.message || 'Error' } : q,
          );
          await saveQueue(current);
          setQueue(current);
        }
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, []);

  // Auto-sync when online and queue has items
  useEffect(() => {
    if (online && queue.some((q) => q.status !== 'syncing')) {
      void syncNow();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online]);

  const value = useMemo<Ctx>(
    () => ({ online, queue, pendingCount: queue.length, enqueue, syncNow, syncing }),
    [online, queue, enqueue, syncNow, syncing],
  );

  return <SyncCtx.Provider value={value}>{children}</SyncCtx.Provider>;
}

export function useSync() {
  const ctx = useContext(SyncCtx);
  if (!ctx) throw new Error('useSync fuera de SyncProvider');
  return ctx;
}
