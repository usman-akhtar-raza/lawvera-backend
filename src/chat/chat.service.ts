import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import { ChatMessage, ChatMessageDocument } from './schemas/chat-message.schema';
import { AskQuestionDto } from './dto/ask-question.dto';
import { ChatRole } from '../common/enums/chat-role.enum';
import { UserRole } from '../common/enums/role.enum';
import { LawSourcesService } from '../law-sources/law-sources.service';
import { RetrievedChunk } from '../law-sources/law-sources.types';

const NOT_FOUND_MESSAGE = 'I couldn\'t find this in the provided law books.';

type Citation = {
  sourceTitle: string;
  sourceId: string;
  chunkId: string;
  metadata: Record<string, unknown> | null;
};

@Injectable()
export class ChatService {
  private readonly openai: OpenAI | null;

  constructor(
    @InjectModel(ChatMessage.name)
    private readonly chatModel: Model<ChatMessageDocument>,
    private readonly configService: ConfigService,
    private readonly lawSourcesService: LawSourcesService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async ask(userId: string, userRole: UserRole, dto: AskQuestionDto) {
    const sessionId = dto.sessionId ?? new Types.ObjectId().toString();
    const history = await this.chatModel
      .find({ sessionId, user: userId })
      .sort({ createdAt: 1 })
      .lean();

    const mode: 'user' | 'lawyer' = dto.mode ?? (userRole === UserRole.LAWYER ? 'lawyer' : 'user');

    const retrievedChunks = await this.lawSourcesService.retrieveChunks({
      message: dto.message,
      jurisdiction: dto.jurisdiction,
      sourceIds: dto.sourceIds,
      topK: 6,
    });

    const sufficientContext = retrievedChunks.length > 0 && retrievedChunks[0].score >= 0.42;

    let answer = NOT_FOUND_MESSAGE;
    let citations: Citation[] = [];

    if (sufficientContext) {
      if (this.openai) {
        const generated = await this.generateGroundedAnswer({
          question: dto.message,
          history,
          chunks: retrievedChunks,
          mode,
        });
        answer = generated.answer;
        citations = generated.citations;
      } else {
        const first = retrievedChunks[0];
        answer = `Based on available sources, ${first.chunkText.slice(0, 600)}${first.chunkText.length > 600 ? '...' : ''}`;
        citations = [this.toCitation(first)];
      }
    }

    await this.persistMessage(sessionId, userId, ChatRole.USER, dto.message);
    await this.persistMessage(sessionId, userId, ChatRole.ASSISTANT, answer);

    return {
      sessionId,
      answer,
      citations,
      retrievedPreview: retrievedChunks.slice(0, 4).map((chunk) => ({
        sourceTitle: chunk.sourceTitle,
        metadata: chunk.metadata,
        snippet:
          chunk.chunkText.length > 220
            ? `${chunk.chunkText.slice(0, 217)}...`
            : chunk.chunkText,
      })),
    };
  }

  async getSessions(userId: string) {
    const userObjectId = new Types.ObjectId(userId);
    const sessions = await this.chatModel
      .aggregate([
        { $match: { user: userObjectId } },
        { $sort: { createdAt: 1 } },
        {
          $group: {
            _id: '$sessionId',
            firstMessage: { $first: '$$ROOT' },
            lastMessage: { $last: '$$ROOT' },
            messageCount: { $sum: 1 },
          },
        },
        { $sort: { 'lastMessage.createdAt': -1 } },
      ])
      .exec();

    return sessions.map((session) => ({
      sessionId: session._id as string,
      title: this.buildSessionTitle(session.firstMessage?.content),
      lastMessagePreview: this.buildPreview(session.lastMessage?.content),
      updatedAt:
        session.lastMessage?.createdAt ??
        session.firstMessage?.createdAt ??
        new Date(),
      messageCount: session.messageCount,
    }));
  }

  async getSessionHistory(userId: string, sessionId: string) {
    const userObjectId = new Types.ObjectId(userId);
    return this.chatModel
      .find({ sessionId, user: userObjectId })
      .sort({ createdAt: 1 })
      .lean();
  }

  async deleteSession(userId: string, sessionId: string) {
    const userObjectId = new Types.ObjectId(userId);
    const result = await this.chatModel.deleteMany({
      sessionId,
      user: userObjectId,
    });
    return {
      sessionId,
      deleted: result.deletedCount ?? 0,
    };
  }

  private async generateGroundedAnswer(params: {
    question: string;
    history: Array<{
      role: ChatRole;
      content: string;
    }>;
    chunks: RetrievedChunk[];
    mode: 'user' | 'lawyer';
  }): Promise<{ answer: string; citations: Citation[] }> {
    if (!this.openai) {
      return { answer: NOT_FOUND_MESSAGE, citations: [] };
    }

    const contextById = new Map<string, RetrievedChunk>();
    const contextText = params.chunks
      .map((chunk, index) => {
        const contextId = `C${index + 1}`;
        contextById.set(contextId, chunk);
        return [
          `${contextId}`,
          `source_title: ${chunk.sourceTitle}`,
          `source_id: ${chunk.sourceId}`,
          `chunk_id: ${chunk.chunkId}`,
          `metadata: ${JSON.stringify(chunk.metadata ?? {})}`,
          `text: ${chunk.chunkText}`,
        ].join('\n');
      })
      .join('\n\n');

    const styleInstruction =
      params.mode === 'lawyer'
        ? 'Respond in a formal professional tone for legal drafting support. Keep exactness high.'
        : 'Respond in plain language for a general user. Keep legal terms simple and concise.';

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: [
          'You are Lawvera retrieval assistant.',
          'Use ONLY the provided context blocks.',
          `If context is insufficient, respond exactly: ${NOT_FOUND_MESSAGE}`,
          'Do not use external knowledge.',
          styleInstruction,
          'Return JSON with shape: {"answer":"...","citationIds":["C1","C2"]}',
          'citationIds must only include block ids you used.',
        ].join(' '),
      },
      ...params.history.slice(-8).map(
        (item): { role: 'user' | 'assistant'; content: string } => ({
          role: item.role === ChatRole.USER ? 'user' : 'assistant',
          content: item.content,
        }),
      ),
      {
        role: 'user' as const,
        content: `Question: ${params.question}\n\nContext:\n${contextText}`,
      },
    ];

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages,
    });

    const content = completion.choices[0]?.message?.content?.trim();
    if (!content) {
      return { answer: NOT_FOUND_MESSAGE, citations: [] };
    }

    try {
      const parsed = JSON.parse(content) as {
        answer?: string;
        citationIds?: string[];
      };

      const answer = (parsed.answer || '').trim() || NOT_FOUND_MESSAGE;
      const citations = (parsed.citationIds ?? [])
        .map((citationId) => contextById.get(citationId))
        .filter((value): value is RetrievedChunk => Boolean(value))
        .map((chunk) => this.toCitation(chunk));

      if (answer === NOT_FOUND_MESSAGE || citations.length === 0) {
        return {
          answer: NOT_FOUND_MESSAGE,
          citations: [],
        };
      }

      return {
        answer,
        citations,
      };
    } catch {
      return {
        answer: NOT_FOUND_MESSAGE,
        citations: [],
      };
    }
  }

  private toCitation(chunk: RetrievedChunk): Citation {
    return {
      sourceTitle: chunk.sourceTitle,
      sourceId: chunk.sourceId,
      chunkId: chunk.chunkId,
      metadata: chunk.metadata,
    };
  }

  private persistMessage(
    sessionId: string,
    userId: string,
    role: ChatRole,
    content: string,
  ) {
    return this.chatModel.create({
      sessionId,
      user: userId,
      role,
      content,
    });
  }

  private buildSessionTitle(content?: string | null) {
    if (!content) {
      return 'New conversation';
    }

    const normalized = content.trim().replace(/\s+/g, ' ');
    if (!normalized.length) {
      return 'New conversation';
    }

    return normalized.length > 60
      ? `${normalized.slice(0, 57)}...`
      : normalized;
  }

  private buildPreview(content?: string | null) {
    if (!content) {
      return '';
    }

    const normalized = content.trim().replace(/\s+/g, ' ');
    if (!normalized.length) {
      return '';
    }

    return normalized.length > 120
      ? `${normalized.slice(0, 117)}...`
      : normalized;
  }
}
