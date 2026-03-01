import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, type IngestionStatus } from '@prisma/client';
import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { PDFParse } from 'pdf-parse';
import { PrismaService } from '../database/prisma.service';
import { DEFAULT_EMBEDDING_MODEL } from './law-sources.constants';

@Injectable()
export class IngestionProcessorService {
  private readonly logger = new Logger(IngestionProcessorService.name);
  private readonly openai: OpenAI | null;
  private readonly embeddingModel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
    this.embeddingModel = this.configService.get<string>('OPENAI_EMBEDDING_MODEL', DEFAULT_EMBEDDING_MODEL);
  }

  async ingestInline(sourceId: string) {
    const chunkIds = await this.handleExtract(sourceId);
    for (const chunkId of chunkIds) {
      await this.handleEmbed(chunkId);
    }
    if (chunkIds.length > 0) {
      await this.handleIndex(sourceId);
    }
  }

  async handleExtract(sourceId: string): Promise<string[]> {
    const source = await this.prisma.lawSource.findUnique({ where: { id: sourceId } });
    if (!source) {
      return [];
    }

    await this.updateSourceStatus(sourceId, 'extracting');

    let rawText = '';
    try {
      const buffer = await readFile(source.filePath);
      rawText = await this.extractText(buffer, source.filePath);
    } catch (error) {
      this.logger.error(`Failed to extract file for source ${sourceId}`, error as Error);
      await this.prisma.lawSource.update({
        where: { id: sourceId },
        data: {
          ingestionStatus: 'failed',
          warningText: 'Failed to parse uploaded file.',
        },
      });
      return [];
    }

    const normalized = rawText.replace(/\r/g, '\n').replace(/[\t ]+/g, ' ').trim();
    if (normalized.length < 350) {
      await this.prisma.lawSource.update({
        where: { id: sourceId },
        data: {
          ingestionStatus: 'needs_ocr',
          warningText: 'Text extraction returned too little content. OCR is required for scanned files.',
          chunkCount: 0,
        },
      });
      await this.prisma.lawChunk.deleteMany({ where: { sourceId } });
      return [];
    }

    const chunks = this.chunkText(normalized);
    await this.prisma.lawChunk.deleteMany({ where: { sourceId } });

    const chunkIds: string[] = [];
    for (const chunk of chunks) {
      const created = await this.prisma.lawChunk.create({
        data: {
          sourceId,
          chunkText: chunk.chunkText,
          metadataJson: chunk.metadata as Prisma.InputJsonValue,
        },
      });
      chunkIds.push(created.id);
    }

    await this.prisma.lawSource.update({
      where: { id: sourceId },
      data: {
        ingestionStatus: this.openai ? 'embedding' : 'ready',
        warningText: this.openai ? null : 'OPENAI_API_KEY missing. Chunks indexed without embeddings.',
        chunkCount: chunkIds.length,
      },
    });

    return chunkIds;
  }

  async handleEmbed(chunkId: string): Promise<{ sourceId: string; pending: number } | null> {
    const chunk = await this.prisma.lawChunk.findUnique({
      where: { id: chunkId },
      select: {
        id: true,
        sourceId: true,
        chunkText: true,
      },
    });

    if (!chunk) {
      return null;
    }

    const embedding = await this.generateEmbedding(chunk.chunkText);
    if (!embedding) {
      await this.prisma.lawSource.update({
        where: { id: chunk.sourceId },
        data: {
          ingestionStatus: 'failed',
          warningText: 'Embedding generation failed. Check OpenAI configuration.',
        },
      });
      return null;
    }

    const vectorLiteral = `[${embedding.join(',')}]`;
    await this.prisma.$executeRawUnsafe(
      'UPDATE "LawChunk" SET "embedding" = $1::vector WHERE "id" = $2::uuid',
      vectorLiteral,
      chunk.id,
    );

    const pendingRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "LawChunk"
      WHERE "sourceId" = ${chunk.sourceId}::uuid
      AND "embedding" IS NULL
    `);

    const pending = Number(pendingRows[0]?.count ?? 0);
    if (pending === 0) {
      await this.updateSourceStatus(chunk.sourceId, 'indexing');
    }

    return {
      sourceId: chunk.sourceId,
      pending,
    };
  }

  async handleIndex(sourceId: string) {
    const countRows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM "LawChunk"
      WHERE "sourceId" = ${sourceId}::uuid
    `);

    const chunkCount = Number(countRows[0]?.count ?? 0);
    await this.prisma.lawSource.update({
      where: { id: sourceId },
      data: {
        ingestionStatus: 'ready',
        warningText: null,
        chunkCount,
      },
    });
  }

  private async extractText(fileBuffer: Buffer, filePath: string): Promise<string> {
    const extension = extname(filePath).toLowerCase();

    if (extension === '.pdf') {
      const parser = new PDFParse({ data: fileBuffer });
      try {
        const parsed = await parser.getText();
        return parsed.text || '';
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    }

    return fileBuffer.toString('utf8');
  }

  private chunkText(input: string) {
    const tokens = input.split(/\s+/).filter(Boolean);
    const chunkSize = 900;
    const overlap = 120;

    const chunks: Array<{
      chunkText: string;
      metadata: Record<string, unknown>;
    }> = [];

    let index = 0;
    let chunkIndex = 0;
    while (index < tokens.length) {
      const end = Math.min(index + chunkSize, tokens.length);
      const chunkTokens = tokens.slice(index, end);
      chunks.push({
        chunkText: chunkTokens.join(' '),
        metadata: {
          chunkIndex,
          tokenStart: index,
          tokenEnd: end,
        },
      });

      if (end === tokens.length) {
        break;
      }

      index = Math.max(end - overlap, index + 1);
      chunkIndex += 1;
    }

    return chunks;
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
      this.logger.error('Embedding generation failed', error as Error);
      return null;
    }
  }

  private async updateSourceStatus(sourceId: string, status: IngestionStatus) {
    await this.prisma.lawSource.update({
      where: { id: sourceId },
      data: { ingestionStatus: status },
    });
  }
}
