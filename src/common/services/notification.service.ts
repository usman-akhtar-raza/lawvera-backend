import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private transporter?: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST')?.trim();
    const portRaw = this.configService.get<string>('SMTP_PORT', '587') || '587';
    const port = Number.parseInt(portRaw, 10);
    const user = this.configService.get<string>('SMTP_USER')?.trim();
    const pass = this.configService.get<string>('SMTP_PASS');

    if (host && user && pass && !Number.isNaN(port)) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log(`SMTP configured on ${host}:${port}`);
    } else {
      const missing: string[] = [];
      if (!host) missing.push('SMTP_HOST');
      if (!user) missing.push('SMTP_USER');
      if (!pass) missing.push('SMTP_PASS');
      this.logger.warn(
        `SMTP not configured (missing: ${missing.join(', ')}) — notifications will be logged only`,
      );
    }
  }

  private async sendEmail(
    to: string,
    subject: string,
    html: string,
  ): Promise<void> {
    if (this.transporter) {
      const from = this.configService.get<string>(
        'SMTP_FROM',
        `Lawvera <${this.configService.get<string>('SMTP_USER')}>`,
      );
      const info: unknown = await this.transporter.sendMail({
        from,
        to,
        subject,
        html,
      });
      this.logger.log(
        `Notification sent to ${to} (messageId: ${this.extractMessageId(info)})`,
      );
    } else {
      this.logger.warn(`[DEV] Notification to ${to}: ${subject}`);
    }
  }

  async sendApprovalEmail(email: string, name: string): Promise<void> {
    const subject = 'Lawvera — Your lawyer profile has been approved';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fbf7f0;border-radius:12px;">
        <h2 style="color:#1B3A5C;margin-bottom:8px;">Lawvera</h2>
        <p style="color:#333;font-size:15px;">Hi ${name},</p>
        <p style="color:#333;font-size:15px;">
          Congratulations! Your lawyer profile application has been
          <strong style="color:#1f3d36;">approved</strong>.
        </p>
        <p style="color:#333;font-size:15px;">
          Your profile is now live and visible to clients. Log in to start accepting bookings.
        </p>
        <p style="color:#666;font-size:13px;margin-top:24px;">
          If you have any questions, please contact our support team.
        </p>
      </div>
    `;
    await this.sendEmail(email, subject, html);
  }

  async sendRejectionEmail(email: string, name: string): Promise<void> {
    const subject = 'Lawvera — Update on your lawyer profile application';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#fbf7f0;border-radius:12px;">
        <h2 style="color:#1B3A5C;margin-bottom:8px;">Lawvera</h2>
        <p style="color:#333;font-size:15px;">Hi ${name},</p>
        <p style="color:#333;font-size:15px;">
          After reviewing your lawyer profile application, we were unable to approve it at this time.
        </p>
        <p style="color:#333;font-size:15px;">
          Your account has been reverted to a standard client account. You may still use Lawvera
          to find and book lawyers. If you believe this was an error or need more information,
          please contact our support team.
        </p>
        <p style="color:#666;font-size:13px;margin-top:24px;">
          Thank you for your interest in joining Lawvera as a legal professional.
        </p>
      </div>
    `;
    await this.sendEmail(email, subject, html);
  }

  async sendBookingMeetingLinkEmail(payload: {
    clientEmail: string;
    clientName: string;
    lawyerName: string;
    meetingLink: string;
    slotDate: Date;
    slotTime: string;
  }): Promise<void> {
    const formattedDate = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'full',
      timeZone: 'Asia/Karachi',
    }).format(payload.slotDate);
    const subject = 'Lawvera — Your meeting link is ready';
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px;background:#fbf7f0;border-radius:12px;">
        <h2 style="color:#1B3A5C;margin-bottom:8px;">Lawvera</h2>
        <p style="color:#333;font-size:15px;">Hi ${payload.clientName},</p>
        <p style="color:#333;font-size:15px;">
          ${payload.lawyerName} has shared the meeting link for your consultation.
        </p>
        <div style="margin:20px 0;padding:16px;border:1px solid #e5d7bf;border-radius:10px;background:#fffdf9;">
          <p style="margin:0 0 8px;color:#333;font-size:14px;"><strong>Date:</strong> ${formattedDate}</p>
          <p style="margin:0 0 8px;color:#333;font-size:14px;"><strong>Time:</strong> ${payload.slotTime}</p>
          <p style="margin:0;color:#333;font-size:14px;"><strong>Meeting Link:</strong> <a href="${payload.meetingLink}" target="_blank" rel="noopener noreferrer">${payload.meetingLink}</a></p>
        </div>
        <p style="color:#666;font-size:13px;">
          Please join the meeting a few minutes before your appointment starts.
        </p>
      </div>
    `;
    await this.sendEmail(payload.clientEmail, subject, html);
  }

  notifyLawyer(lawyerId: string, message: string): Promise<void> {
    this.logger.log(`Notify lawyer ${lawyerId}: ${message}`);
    return Promise.resolve();
  }

  notifyClient(clientId: string, message: string): Promise<void> {
    this.logger.log(`Notify client ${clientId}: ${message}`);
    return Promise.resolve();
  }

  private extractMessageId(info: unknown): string {
    if (
      typeof info === 'object' &&
      info !== null &&
      'messageId' in info &&
      typeof (info as { messageId?: unknown }).messageId === 'string'
    ) {
      return (info as { messageId: string }).messageId;
    }

    return 'unknown';
  }
}
