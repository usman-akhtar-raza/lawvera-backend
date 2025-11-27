import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AskQuestionDto } from './dto/ask-question.dto';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @UseGuards(JwtAuthGuard)
  @Post('ask')
  ask(
    @CurrentUser() user: { userId: string },
    @Body() dto: AskQuestionDto,
  ) {
    return this.chatService.ask(user.userId, dto);
  }
}
