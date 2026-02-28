import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LawSourceStatus, Prisma } from '@prisma/client';
import OpenAI from 'openai';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { PrismaService } from '../database/prisma.service';
import { DEFAULT_EMBEDDING_MODEL, MAX_UPLOAD_BYTES } from './law-sources.constants';
import { UploadLawSourceDto } from './dto/upload-law-source.dto';
import { UpdateLawSourceDto } from './dto/update-law-source.dto';
import { IngestionQueueService } from './ingestion-queue.service';
import { RetrievedChunk } from './law-sources.types';
import { LawSourceUploadFile } from './law-source-file.type';

@Injectable()
export class LawSourcesService {
  private readonly logger = new Logger(LawSourcesService.name);
  private readonly openai: OpenAI | null;
  private readonly embeddingModel: string;
  private readonly uploadRoot: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly ingestionQueue: IngestionQueueService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    this.embeddingModel = this.configService.get<string>('OPENAI_EMBEDDING_MODEL', DEFAULT_EMBEDDING_MODEL);

    const configuredUploadDir = this.configService.get<string>('LAW_SOURCE_UPLOAD_DIR', 'uploads/law-sources');
    this.uploadRoot = resolve(process.cwd(), configuredUploadDir);
  }

  async upload(file: LawSourceUploadFile, dto: UploadLawSourceDto) {
    this.validateUpload(file);

    await mkdir(this.uploadRoot, { recursive: true });

    const fileHash = createHash('sha256').update(file.buffer).digest('hex');
    const existing = await this.prisma.lawSource.findUnique({
      where: { fileHash },
    });

    if (existing) {
      return existing;
    }

    const extension = extname(file.originalname || '').toLowerCase() || '.txt';
    const baseName = basename(file.originalname || 'source', extension)
      .replace(/[^a-zA-Z0-9-_\s]/g, '')
      .trim()
      .replace(/\s+/g, '-');
    const safeName = `${Date.now()}-${baseName || 'law-source'}-${randomUUID()}${extension}`;
    const filePath = join(this.uploadRoot, safeName);

    await writeFile(filePath, file.buffer);

    const created = await this.prisma.lawSource.create({
      data: {
        title: dto.title?.trim() || basename(file.originalname || safeName, extension),
        edition: dto.edition?.trim() || null,
        jurisdiction: dto.jurisdiction?.trim() || null,
        language: dto.language?.trim() || null,
        status: LawSourceStatus.active,
        filePath,
        fileHash,
        ingestionStatus: 'uploaded',
      },
    });

    await this.ingestionQueue.enqueueExtract(created.id);

    return created;
  }

  async list() {
    return this.prisma.lawSource.findMany({
      orderBy: { createdAt: 'desc' },
    });
  }

  async updateStatus(sourceId: string, dto: UpdateLawSourceDto) {
    const source = await this.prisma.lawSource.findUnique({ where: { id: sourceId } });
    if (!source) {
      throw new NotFoundException('Law source not found');
    }

    return this.prisma.lawSource.update({
      where: { id: sourceId },
      data: {
        status: dto.status,
      },
    });
  }

  async delete(sourceId: string) {
    const source = await this.prisma.lawSource.findUnique({ where: { id: sourceId } });
    if (!source) {
      throw new NotFoundException('Law source not found');
    }

    await this.prisma.lawSource.delete({ where: { id: sourceId } });

    try {
      await unlink(source.filePath);
    } catch {
      this.logger.warn(`Source file not found at delete time: ${source.filePath}`);
    }

    return { success: true as const };
  }

  async retrieveChunks(params: {
    message: string;
    jurisdiction?: string;
    sourceIds?: string[];
    topK?: number;
  }): Promise<RetrievedChunk[]> {
    if (!this.openai) {
      return [];
    }

    const embedding = await this.generateEmbedding(params.message);
    if (!embedding) {
      return [];
    }

    const vectorLiteral = `[${embedding.join(',')}]`;
    const topK = Math.min(Math.max(params.topK ?? 6, 1), 12);
    const sourceIds = (params.sourceIds ?? []).filter(Boolean);

    const sourceFilter = sourceIds.length
      ? Prisma.sql`AND ls."id" = ANY (ARRAY[${Prisma.join(sourceIds)}]::uuid[])`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<Array<{
      chunkId: string;
      sourceId: string;
      sourceTitle: string;
      chunkText: string;
      metadataJson: Record<string, unknown> | null;
      score: number;
    }>>(Prisma.sql`
      SELECT
        lc."id" AS "chunkId",
        lc."sourceId" AS "sourceId",
        ls."title" AS "sourceTitle",
        lc."chunkText" AS "chunkText",
        lc."metadataJson" AS "metadataJson",
        1 - (lc."embedding" <=> ${vectorLiteral}::vector) AS "score"
      FROM "LawChunk" lc
      INNER JOIN "LawSource" ls ON ls."id" = lc."sourceId"
      WHERE ls."status" = 'active'
      AND lc."embedding" IS NOT NULL
      ${params.jurisdiction ? Prisma.sql`AND ls."jurisdiction" = ${params.jurisdiction}` : Prisma.empty}
      ${sourceFilter}
      ORDER BY lc."embedding" <=> ${vectorLiteral}::vector
      LIMIT ${topK}
    `);

    return rows.map((row) => ({
      chunkId: row.chunkId,
      sourceId: row.sourceId,
      sourceTitle: row.sourceTitle,
      chunkText: row.chunkText,
      metadata: row.metadataJson ?? null,
      score: Number(row.score),
    }));
  }

  private validateUpload(file: LawSourceUploadFile) {
    if (!file) {
      throw new BadRequestException('Upload file is required');
    }

    if (!file.originalname) {
      throw new BadRequestException('Invalid file upload');
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('File exceeds 20MB size limit');
    }

    const extension = extname(file.originalname).toLowerCase();
    if (!['.pdf', '.txt', '.md'].includes(extension)) {
      throw new BadRequestException('Only PDF, TXT, and MD files are allowed');
    }
  }

  private async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.openai) {
      return null;
    }

    try {
      const response = await this.openai.embeddings.create({
        model: this.embeddingModel,
        input: text,
      });
      return response.data[0]?.embedding ?? null;
    } catch (error) {
      this.logger.error('Failed to create query embedding', error as Error);
      return null;
    }
  }
}
