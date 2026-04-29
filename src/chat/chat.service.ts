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
const GENERAL_LEGAL_DISCLAIMER =
  'This is general legal information, not a substitute for advice from a licensed lawyer.';
const OUT_OF_SCOPE_MESSAGE =
  'I’m here to help with legal information, legal research, and questions related to legal services on Lawvera. I’m not able to assist with non-legal topics here. If you have a legal question, a legal document, or a case-related issue, send it and I’ll help in a professional and practical way.';

const LEGAL_SCOPE_KEYWORDS = [
  'legal',
  'law',
  'lawyer',
  'attorney',
  'advocate',
  'court',
  'judge',
  'case',
  'contract',
  'agreement',
  'breach',
  'notice',
  'petition',
  'affidavit',
  'complaint',
  'lawsuit',
  'sue',
  'appeal',
  'bail',
  'fir',
  'police',
  'crime',
  'criminal',
  'civil',
  'divorce',
  'custody',
  'alimony',
  'inheritance',
  'will',
  'probate',
  'property',
  'tenant',
  'landlord',
  'lease',
  'rent',
  'employment',
  'termination',
  'harassment',
  'tax',
  'compliance',
  'regulation',
  'license',
  'permit',
  'company',
  'startup',
  'incorporate',
  'registration',
  'trademark',
  'copyright',
  'patent',
  'evidence',
  'jurisdiction',
  'rights',
  'liability',
  'damages',
  'settlement',
  'arbitration',
  'mediation',
  'consumer',
  'visa',
  'immigration',
];

const NON_LEGAL_TOPIC_KEYWORDS = [
  'weather',
  'temperature',
  'recipe',
  'cook',
  'cooking',
  'movie',
  'film',
  'song',
  'music',
  'lyrics',
  'game',
  'gaming',
  'football',
  'cricket',
  'basketball',
  'travel',
  'flight',
  'hotel',
  'restaurant',
  'diet',
  'workout',
  'exercise',
  'math',
  'algebra',
  'physics',
  'chemistry',
  'programming',
  'coding',
  'code',
  'javascript',
  'python',
  'react',
  'nextjs',
  'anime',
  'fashion',
  'makeup',
  'horoscope',
];

const PREDEFINED_ANSWERS: Array<{
  questions: string[];
  answer: string;
}> = [
  {
    questions: [
      'what is lawvera',
      'what is lawvera copilot',
      'who are you',
    ],
    answer:
      'Lawvera Copilot is a legal research assistant for Lawvera. It can summarize uploaded law books when relevant sources are found and can also provide general legal information when the uploaded sources do not contain a direct answer.',
  },
  {
    questions: [
      'is this legal advice',
      'do you provide legal advice',
      'are you a lawyer',
    ],
    answer:
      'No. Lawvera Copilot provides legal information and research support only. For advice about a specific case, rights, deadlines, or court strategy, consult a licensed lawyer in the relevant jurisdiction.',
  },
  {
    questions: [
      'what is a contract',
      'define contract',
      'what makes a contract valid',
    ],
    answer:
      'A contract is a legally enforceable agreement. In general, a valid contract requires an offer, acceptance, lawful consideration, competent parties, free consent, and a lawful object. The exact requirements can vary by jurisdiction and facts.',
  },
  {
    questions: [
      'what is bail',
      'define bail',
    ],
    answer:
      'Bail is the temporary release of an accused person from custody while a case is pending, usually subject to conditions set by a court. Courts commonly consider the nature of the accusation, risk of absconding, likelihood of tampering with evidence, and the accused person’s circumstances.',
  },
  {
    questions: [
      'what is fir',
      'what is an fir',
      'define fir',
    ],
    answer:
      'An FIR, or First Information Report, is a formal record prepared by police when information about a cognizable offence is received. It usually starts the criminal investigation process and records the basic facts, parties, place, time, and alleged offence.',
  },
];

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
    const predefinedAnswer = this.findPredefinedAnswer(dto.message);
    if (predefinedAnswer) {
      await this.persistMessage(sessionId, userId, ChatRole.USER, dto.message);
      await this.persistMessage(
        sessionId,
        userId,
        ChatRole.ASSISTANT,
        predefinedAnswer,
      );

      return {
        sessionId,
        answer: predefinedAnswer,
        citations: [],
        retrievedPreview: [],
      };
    }

    const history = await this.chatModel
      .find({ sessionId, user: userId })
      .sort({ createdAt: 1 })
      .lean();

    const isLegalScope = await this.isLegalScopeQuestion({
      question: dto.message,
      history,
    });
    if (!isLegalScope) {
      await this.persistMessage(sessionId, userId, ChatRole.USER, dto.message);
      await this.persistMessage(
        sessionId,
        userId,
        ChatRole.ASSISTANT,
        OUT_OF_SCOPE_MESSAGE,
      );

      return {
        sessionId,
        answer: OUT_OF_SCOPE_MESSAGE,
        citations: [],
        retrievedPreview: [],
      };
    }

    const mode: 'user' | 'lawyer' = dto.mode ?? (userRole === UserRole.LAWYER ? 'lawyer' : 'user');

    const retrievedChunks = await this.lawSourcesService.retrieveChunks({
      message: dto.message,
      jurisdiction: dto.jurisdiction,
      sourceIds: dto.sourceIds,
      topK: 6,
    });

    const sufficientContext = retrievedChunks.length > 0 && retrievedChunks[0].score >= 0.42;

    let answer = '';
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

    if (!answer || answer === NOT_FOUND_MESSAGE) {
      answer = await this.generateContextualLegalAnswer({
        question: dto.message,
        history,
        mode,
      });
      citations = [];
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
        snippet: chunk.chunkText,
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

  private async generateContextualLegalAnswer(params: {
    question: string;
    history: Array<{
      role: ChatRole;
      content: string;
    }>;
    mode: 'user' | 'lawyer';
  }) {
    if (!this.openai) {
      return this.buildConservativeFallbackAnswer(params.question);
    }

    const styleInstruction =
      params.mode === 'lawyer'
        ? 'Use a professional legal research tone. Be concise, identify likely legal issues, and avoid inventing jurisdiction-specific sections or case names.'
        : 'Use plain language. Keep the answer practical and easy to understand.';

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: [
            'You are Lawvera Copilot.',
            'The uploaded law-book retrieval did not provide enough support for this question.',
            'Give a relevant, contextual legal-information answer using general legal principles.',
            'Do not claim the answer came from uploaded law books.',
            'Do not cite statutes, sections, or cases unless the user provided them.',
            'Mention when jurisdiction or facts may change the outcome.',
            styleInstruction,
            `End with this sentence: ${GENERAL_LEGAL_DISCLAIMER}`,
          ].join(' '),
        },
        ...params.history.slice(-6).map(
          (item): { role: 'user' | 'assistant'; content: string } => ({
            role: item.role === ChatRole.USER ? 'user' : 'assistant',
            content: item.content,
          }),
        ),
        {
          role: 'user',
          content: params.question,
        },
      ],
    });

    const content = completion.choices[0]?.message?.content?.trim();
    return content || this.buildConservativeFallbackAnswer(params.question);
  }

  private findPredefinedAnswer(message: string) {
    const normalizedMessage = this.normalizeQuestion(message);
    const matched = PREDEFINED_ANSWERS.find((entry) =>
      entry.questions.some(
        (question) => this.normalizeQuestion(question) === normalizedMessage,
      ),
    );

    return matched?.answer;
  }

  private normalizeQuestion(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async isLegalScopeQuestion(params: {
    question: string;
    history: Array<{
      role: ChatRole;
      content: string;
    }>;
  }) {
    const heuristicResult = this.classifyScopeHeuristically(
      params.question,
      params.history,
    );
    if (heuristicResult !== 'ambiguous') {
      return heuristicResult === 'legal';
    }

    if (!this.openai) {
      return false;
    }

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: [
              'You classify whether a user message is within Lawvera scope.',
              'Return JSON only: {"isLegal":true} or {"isLegal":false}.',
              'isLegal must be true only for legal information, legal research, legal documents, legal rights, legal procedures, regulatory/compliance matters, or questions about hiring/working with lawyers on the platform.',
              'isLegal must be false for general knowledge, entertainment, health, coding, mathematics, travel, shopping, or any non-legal topic.',
              'Use conversation history only to resolve short follow-up messages.',
            ].join(' '),
          },
          {
            role: 'user',
            content: JSON.stringify({
              question: params.question,
              recentHistory: params.history.slice(-4).map((item) => ({
                role: item.role,
                content: item.content,
              })),
            }),
          },
        ],
      });

      const content = completion.choices[0]?.message?.content?.trim();
      if (!content) {
        return false;
      }

      const parsed = JSON.parse(content) as { isLegal?: boolean };
      return parsed.isLegal === true;
    } catch {
      return false;
    }
  }

  private classifyScopeHeuristically(
    question: string,
    history: Array<{
      role: ChatRole;
      content: string;
    }>,
  ) {
    const normalizedQuestion = this.normalizeQuestion(question);
    const questionLower = ` ${normalizedQuestion} `;
    const hasLegalKeyword = LEGAL_SCOPE_KEYWORDS.some((keyword) =>
      questionLower.includes(` ${keyword} `),
    );
    const hasNonLegalKeyword = NON_LEGAL_TOPIC_KEYWORDS.some((keyword) =>
      questionLower.includes(` ${keyword} `),
    );

    if (hasLegalKeyword) {
      return 'legal' as const;
    }

    if (hasNonLegalKeyword) {
      return 'non_legal' as const;
    }

    const shortFollowUp =
      normalizedQuestion.split(' ').length <= 6 &&
      /^(and|what|how|why|when|where|can|should|would|could|is|are|do|does|did)\b/.test(
        normalizedQuestion,
      );

    if (shortFollowUp) {
      const recentText = history
        .slice(-4)
        .map((item) => this.normalizeQuestion(item.content))
        .join(' ');
      const recentLower = ` ${recentText} `;
      const historyLooksLegal = LEGAL_SCOPE_KEYWORDS.some((keyword) =>
        recentLower.includes(` ${keyword} `),
      );

      if (historyLooksLegal) {
        return 'legal' as const;
      }
    }

    if (
      /\b(draft|review|summarize|explain|interpret|analyze)\b/.test(
        normalizedQuestion,
      ) &&
      /\b(contract|agreement|notice|petition|affidavit|lease|policy|clause|document)\b/.test(
        normalizedQuestion,
      )
    ) {
      return 'legal' as const;
    }

    return 'ambiguous' as const;
  }

  private buildConservativeFallbackAnswer(question: string) {
    const normalized = this.normalizeQuestion(question);
    const lower = ` ${normalized} `;
    const topic = lower.includes(' bail ')
      ? 'bail'
      : lower.includes(' contract ') || lower.includes(' agreement ')
        ? 'contract'
        : lower.includes(' fir ') || lower.includes(' police ')
          ? 'criminal complaint'
          : lower.includes(' divorce ') || lower.includes(' custody ')
            ? 'family law'
            : lower.includes(' property ') || lower.includes(' rent ')
              ? 'property'
              : 'legal issue';

    return [
      `I do not have a strong match in the uploaded law books, but I can give a general ${topic} overview.`,
      'Start by identifying the jurisdiction, the parties involved, the key dates, and any written documents or official notices.',
      'The legal outcome usually depends on the exact facts, applicable local law, available evidence, limitation periods, and procedural requirements.',
      'For a safer next step, collect the relevant documents and ask a lawyer to review the facts before taking action in court or before an authority.',
      GENERAL_LEGAL_DISCLAIMER,
    ].join('\n\n');
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
