import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AskQuestionDto } from './dto/ask-question.dto';
import { UserRole } from '../common/enums/role.enum';

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @UseGuards(JwtAuthGuard)
  @Post('ask')
  ask(
    @CurrentUser() user: { userId: string; role: UserRole },
    @Body() dto: AskQuestionDto,
  ) {
    return this.chatService.ask(user.userId, user.role, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions')
  getSessions(@CurrentUser() user: { userId: string }) {
    return this.chatService.getSessions(user.userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('sessions/:sessionId')
  getSessionHistory(
    @CurrentUser() user: { userId: string },
    @Param('sessionId') sessionId: string,
  ) {
    return this.chatService.getSessionHistory(user.userId, sessionId);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('sessions/:sessionId')
  deleteSession(
    @CurrentUser() user: { userId: string },
    @Param('sessionId') sessionId: string,
  ) {
    return this.chatService.deleteSession(user.userId, sessionId);
  }
}
