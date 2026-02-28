import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue, Worker, type ConnectionOptions } from 'bullmq';
import {
  INGESTION_EMBED_QUEUE,
  INGESTION_EXTRACT_QUEUE,
  INGESTION_INDEX_QUEUE,
} from './law-sources.constants';
import { IngestionProcessorService } from './ingestion-processor.service';

@Injectable()
export class IngestionQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionQueueService.name);

  private queueEnabled = true;
  private connection: ConnectionOptions | null = null;
  private extractQueue: Queue | null = null;
  private embedQueue: Queue | null = null;
  private indexQueue: Queue | null = null;

  private extractWorker: Worker | null = null;
  private embedWorker: Worker | null = null;
  private indexWorker: Worker | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly processor: IngestionProcessorService,
  ) {}

  async onModuleInit() {
    this.queueEnabled =
      this.configService.get<string>('INGESTION_QUEUE_ENABLED', 'true') === 'true';
    if (!this.queueEnabled) {
      this.logger.warn('Ingestion queue disabled. Running in inline mode.');
      return;
    }

    const redisUrl = this.configService.get<string>(
      'REDIS_URL',
      'redis://127.0.0.1:6379',
    );

    try {
      this.connection = this.buildConnection(redisUrl);

      this.extractQueue = new Queue(INGESTION_EXTRACT_QUEUE, {
        connection: this.connection,
      });
      this.embedQueue = new Queue(INGESTION_EMBED_QUEUE, {
        connection: this.connection,
      });
      this.indexQueue = new Queue(INGESTION_INDEX_QUEUE, {
        connection: this.connection,
      });

      this.extractWorker = new Worker(
        INGESTION_EXTRACT_QUEUE,
        async (job: Job<{ sourceId: string }>) => {
          const chunkIds = await this.processor.handleExtract(job.data.sourceId);
          for (const chunkId of chunkIds) {
            await this.enqueueEmbed(chunkId);
          }
        },
        { connection: this.connection },
      );

      this.embedWorker = new Worker(
        INGESTION_EMBED_QUEUE,
        async (job: Job<{ chunkId: string }>) => {
          const result = await this.processor.handleEmbed(job.data.chunkId);
          if (result && result.pending === 0) {
            await this.enqueueIndex(result.sourceId);
          }
        },
        { connection: this.connection },
      );

      this.indexWorker = new Worker(
        INGESTION_INDEX_QUEUE,
        async (job: Job<{ sourceId: string }>) => {
          await this.processor.handleIndex(job.data.sourceId);
        },
        { connection: this.connection },
      );

      this.bindWorkerEvents();
      this.logger.log('Ingestion queues initialized');
    } catch {
      this.logger.warn(
        'Redis unavailable for BullMQ. Falling back to inline ingestion mode.',
      );
      this.queueEnabled = false;
      await this.cleanup();
    }
  }

  async onModuleDestroy() {
    await this.cleanup();
  }

  async enqueueExtract(sourceId: string) {
    if (!this.queueEnabled || !this.extractQueue) {
      await this.processor.ingestInline(sourceId);
      return;
    }

    try {
      await this.extractQueue.add(
        'extract',
        { sourceId },
        {
          jobId: `extract:${sourceId}`,
          removeOnComplete: 50,
          removeOnFail: 50,
        },
      );
    } catch {
      await this.processor.ingestInline(sourceId);
    }
  }

  async enqueueEmbed(chunkId: string) {
    if (!this.queueEnabled || !this.embedQueue) {
      await this.processor.handleEmbed(chunkId);
      return;
    }

    try {
      await this.embedQueue.add(
        'embed',
        { chunkId },
        {
          jobId: `embed:${chunkId}`,
          removeOnComplete: 200,
          removeOnFail: 200,
        },
      );
    } catch {
      await this.processor.handleEmbed(chunkId);
    }
  }

  async enqueueIndex(sourceId: string) {
    if (!this.queueEnabled || !this.indexQueue) {
      await this.processor.handleIndex(sourceId);
      return;
    }

    try {
      await this.indexQueue.add(
        'index',
        { sourceId },
        {
          jobId: `index:${sourceId}`,
          removeOnComplete: 50,
          removeOnFail: 50,
        },
      );
    } catch {
      await this.processor.handleIndex(sourceId);
    }
  }

  private bindWorkerEvents() {
    const logFailure =
      (stage: string) => async (job: Job | undefined, error: Error) => {
        const jobLabel = job?.id ? `${job.id}` : 'unknown';
        this.logger.error(`${stage} job failed (${jobLabel}): ${error.message}`);
      };

    this.extractWorker?.on('failed', logFailure('extract'));
    this.embedWorker?.on('failed', logFailure('embed'));
    this.indexWorker?.on('failed', logFailure('index'));
  }

  private buildConnection(redisUrl: string): ConnectionOptions {
    const parsed = new URL(redisUrl);

    return {
      host: parsed.hostname,
      port: Number(parsed.port || '6379'),
      username: parsed.username || undefined,
      password: parsed.password || undefined,
      maxRetriesPerRequest: null,
      tls: parsed.protocol === 'rediss:' ? {} : undefined,
    };
  }

  private async cleanup() {
    await this.extractWorker?.close();
    await this.embedWorker?.close();
    await this.indexWorker?.close();
    await this.extractQueue?.close();
    await this.embedQueue?.close();
    await this.indexQueue?.close();

    this.extractWorker = null;
    this.embedWorker = null;
    this.indexWorker = null;
    this.extractQueue = null;
    this.embedQueue = null;
    this.indexQueue = null;
    this.connection = null;
  }
}
