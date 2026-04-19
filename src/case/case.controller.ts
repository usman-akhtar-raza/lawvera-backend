import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CaseService } from './case.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UserRole } from '../common/enums/role.enum';
import { CreateCaseDto } from './dto/create-case.dto';
import { UpdateCaseStatusDto } from './dto/update-case-status.dto';
import { AssignLawyerDto } from './dto/assign-lawyer.dto';
import { CreateCaseRequestDto } from './dto/create-case-request.dto';
import { SearchCaseFeedDto } from './dto/search-case-feed.dto';

@Controller('cases')
export class CaseController {
  constructor(private readonly caseService: CaseService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT)
  @Post()
  create(
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateCaseDto,
  ) {
    return this.caseService.create(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT)
  @Get('client/me')
  clientCases(@CurrentUser() user: { userId: string }) {
    return this.caseService.getClientCases(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.LAWYER)
  @Get('lawyer/me')
  lawyerCases(@CurrentUser() user: { userId: string }) {
    return this.caseService.getLawyerCases(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.LAWYER)
  @Get('lawyer/feed')
  lawyerCaseFeed(
    @CurrentUser() user: { userId: string },
    @Query() query: SearchCaseFeedDto,
  ) {
    return this.caseService.searchLawyerCaseFeed(user.userId, query);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.LAWYER)
  @Post(':id/requests')
  requestCase(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateCaseRequestDto,
  ) {
    return this.caseService.createLawyerRequest(id, user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.ADMIN)
  @Patch(':id/requests/:lawyerId/accept')
  acceptRequest(
    @Param('id') id: string,
    @Param('lawyerId') lawyerId: string,
    @CurrentUser() user: { userId: string; role: UserRole },
  ) {
    return this.caseService.acceptLawyerRequest(
      id,
      lawyerId,
      user.userId,
      user.role,
    );
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/all')
  adminAll() {
    return this.caseService.adminGetAll();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/analytics')
  analytics() {
    return this.caseService.analytics();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.LAWYER, UserRole.ADMIN)
  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: UserRole },
  ) {
    return this.caseService.findById(id, user.userId, user.role);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.ADMIN)
  @Patch(':id/assign')
  assignLawyer(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: UserRole },
    @Body() dto: AssignLawyerDto,
  ) {
    return this.caseService.assignLawyer(id, dto, user.userId, user.role);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.LAWYER, UserRole.ADMIN)
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: UserRole },
    @Body() dto: UpdateCaseStatusDto,
  ) {
    return this.caseService.updateStatus(id, dto, user.userId, user.role);
  }
}
