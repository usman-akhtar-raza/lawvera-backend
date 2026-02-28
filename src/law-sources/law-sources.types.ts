export type RetrievedChunk = {
  chunkId: string;
  sourceId: string;
  sourceTitle: string;
  chunkText: string;
  metadata: Record<string, unknown> | null;
  score: number;
};
