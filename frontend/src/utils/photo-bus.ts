// Lightweight in-memory pub/sub used by the camera screen to deliver
// watermarked photos back to the new-report screen without route params
// (base64 strings are too large to embed in URLs).

type Listener = (image: string) => void;
const listeners = new Set<Listener>();

export const photoBus = {
  subscribe(fn: Listener): () => void {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  emit(image: string): void {
    listeners.forEach((l) => l(image));
  },
};
