import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CommunicationService } from './communication.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../common/enums/role.enum';
import { SendMessageDto } from './dto/send-message.dto';

@Controller('communication')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.CLIENT, UserRole.LAWYER, UserRole.ADMIN)
export class CommunicationController {
  constructor(private readonly communicationService: CommunicationService) {}

  @Get('threads')
  getThreads(@CurrentUser() user: { userId: string; role: UserRole }) {
    return this.communicationService.listThreads(user.userId, user.role);
  }

  @Get('cases/:caseId/messages')
  getCaseMessages(
    @Param('caseId') caseId: string,
    @CurrentUser() user: { userId: string; role: UserRole },
  ) {
    return this.communicationService.getCaseMessages(
      caseId,
      user.userId,
      user.role,
    );
  }

  @Post('cases/:caseId/messages')
  sendMessage(
    @Param('caseId') caseId: string,
    @CurrentUser() user: { userId: string; role: UserRole },
    @Body() dto: SendMessageDto,
  ) {
    return this.communicationService.sendCaseMessage(
      caseId,
      user.userId,
      user.role,
      dto,
    );
  }

  @Post('cases/:caseId/read')
  markCaseMessagesRead(
    @Param('caseId') caseId: string,
    @CurrentUser() user: { userId: string; role: UserRole },
  ) {
    return this.communicationService.markCaseMessagesRead(
      caseId,
      user.userId,
      user.role,
    );
  }
}

