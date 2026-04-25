import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { BookingService } from './booking.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateBookingDto } from './dto/create-booking.dto';
import { UpdateBookingStatusDto } from './dto/update-booking-status.dto';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/role.enum';

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT)
  @Post()
  create(
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateBookingDto,
  ) {
    return this.bookingService.createCheckout(user.userId, dto);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT)
  @Get('client/me')
  myBookings(@CurrentUser() user: { userId: string }) {
    return this.bookingService.getClientBookings(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.LAWYER)
  @Get('lawyer/me')
  lawyerBookings(@CurrentUser() user: { userId: string }) {
    return this.bookingService.getLawyerBookings(user.userId);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.LAWYER)
  @Get('finances/me')
  myFinances(@CurrentUser() user: { userId: string; role: UserRole }) {
    return this.bookingService.getMyFinances(user);
  }

  @Get('payments/jazzcash/redirect')
  async jazzCashRedirect(
    @Query('bookingId') bookingId: string,
    @Query('token') token: string,
    @Res() res: Response,
  ) {
    const html = await this.bookingService.renderJazzCashRedirectForm(
      bookingId,
      token,
    );

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.type('html').send(html);
  }

  @Post('payments/jazzcash/callback')
  async jazzCashCallbackPost(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.bookingService.handleJazzCashCallback(
      req.body as Record<string, unknown>,
    );
    res.redirect(result.redirectUrl);
  }

  @Get('payments/jazzcash/callback')
  async jazzCashCallbackGet(
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const result = await this.bookingService.handleJazzCashCallback(
      req.query as Record<string, unknown>,
    );
    res.redirect(result.redirectUrl);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.LAWYER, UserRole.ADMIN)
  @Get(':id/payment-status')
  getPaymentStatus(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: UserRole },
  ) {
    return this.bookingService.getPaymentStatus(id, user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.LAWYER, UserRole.ADMIN)
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: UserRole },
    @Body() dto: UpdateBookingStatusDto,
  ) {
    return this.bookingService.updateStatus(id, dto, user);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.CLIENT, UserRole.LAWYER, UserRole.ADMIN)
  @Patch(':id/cancel')
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: { userId: string; role: UserRole },
  ) {
    return this.bookingService.cancelBooking(id, user.userId, user.role);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/all')
  adminBookings() {
    return this.bookingService.adminBookings();
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/analytics')
  analytics() {
    return this.bookingService.analytics();
  }
}
