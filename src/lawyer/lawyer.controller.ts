import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LawyerService } from './lawyer.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';
import { CreateLawyerDto } from './dto/create-lawyer.dto';
import { UpdateLawyerDto } from './dto/update-lawyer.dto';
import { UpdateAvailabilityDto } from './dto/update-availability.dto';
import { SearchLawyersDto } from './dto/search-lawyers.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateReviewDto } from './dto/create-review.dto';
import { ManageSpecializationDto } from './dto/manage-specialization.dto';

@Controller('lawyers')
export class LawyerController {
  constructor(private readonly lawyerService: LawyerService) {}

  @Get()
  search(@Query() query: SearchLawyersDto) {
    return this.lawyerService.search(query);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.lawyerService.findById(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.LAWYER)
  @Get('me/profile')
  myProfile(@CurrentUser() user: { userId: string }) {
    return this.lawyerService.findByUserId(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post()
  create(@Body() dto: CreateLawyerDto) {
    return this.lawyerService.create(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateLawyerDto) {
    return this.lawyerService.update(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.LAWYER)
  @Patch('me/availability')
  updateAvailability(
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateAvailabilityDto,
  ) {
    return this.lawyerService.updateAvailability(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT)
  @Post(':id/reviews')
  addReview(
    @Param('id') lawyerId: string,
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateReviewDto,
  ) {
    return this.lawyerService.addReview(lawyerId, user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/approve')
  approve(@Param('id') lawyerId: string) {
    return this.lawyerService.approveLawyer(lawyerId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/reject')
  reject(@Param('id') lawyerId: string) {
    return this.lawyerService.rejectLawyer(lawyerId);
  }

  @Get('specializations/list')
  listSpecializations() {
    return this.lawyerService.listSpecializations();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('specializations')
  createSpecialization(@Body() dto: ManageSpecializationDto) {
    return this.lawyerService.createSpecialization(dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('specializations/:id')
  updateSpecialization(
    @Param('id') id: string,
    @Body() dto: ManageSpecializationDto,
  ) {
    return this.lawyerService.updateSpecialization(id, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete('specializations/:id')
  removeSpecialization(@Param('id') id: string) {
    return this.lawyerService.removeSpecialization(id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.LAWYER)
  @Get('me/dashboard')
  dashboard(@CurrentUser() user: { userId: string }) {
    return this.lawyerService.getDashboard(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/overview')
  adminOverview() {
    return this.lawyerService.getAdminOverview();
  }
}
