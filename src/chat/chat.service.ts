import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import OpenAI from 'openai';
import { ConfigService } from '@nestjs/config';
import { ChatMessage, ChatMessageDocument } from './schemas/chat-message.schema';
import { AskQuestionDto } from './dto/ask-question.dto';
import { ChatRole } from '../common/enums/chat-role.enum';

@Injectable()
export class ChatService {
  private readonly openai: OpenAI | null;

  constructor(
    @InjectModel(ChatMessage.name)
    private readonly chatModel: Model<ChatMessageDocument>,
    private readonly configService: ConfigService,
  ) {
    const apiKey = this.configService.get<string>('OPENAI_API_KEY');
    this.openai = apiKey ? new OpenAI({ apiKey }) : null;
  }

  async ask(userId: string, dto: AskQuestionDto) {
    const sessionId = dto.sessionId ?? new Types.ObjectId().toString();
    const history = await this.chatModel
      .find({ sessionId, user: userId })
      .sort({ createdAt: 1 })
      .lean();

    const promptHistory = history.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    const systemPrompt =
      'You are Lawvera, a helpful legal assistant. Provide concise, informative legal guidance but remind users to consult a licensed lawyer for formal advice.';

    const messages: Array<{
      role: 'system' | 'user' | 'assistant';
      content: string;
    }> = [
      { role: 'system', content: systemPrompt },
      ...promptHistory,
      { role: 'user', content: dto.message },
    ];

    let answer =
      'Our AI assistant is currently unavailable. Please try again later.';

    if (this.openai) {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0.4,
      });
      answer =
        response.choices[0]?.message?.content ??
        'I am sorry, I could not process that request.';
    }

    await this.persistMessage(sessionId, userId, ChatRole.USER, dto.message);
    await this.persistMessage(sessionId, userId, ChatRole.ASSISTANT, answer);

    return {
      sessionId,
      answer,
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
}
