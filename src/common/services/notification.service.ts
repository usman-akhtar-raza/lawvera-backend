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

  private async sendEmail(to: string, subject: string, html: string): Promise<void> {
    if (this.transporter) {
      const from = this.configService.get<string>(
        'SMTP_FROM',
        `Lawvera <${this.configService.get<string>('SMTP_USER')}>`,
      );
      const info = await this.transporter.sendMail({ from, to, subject, html });
      this.logger.log(`Notification sent to ${to} (messageId: ${info.messageId})`);
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

  async notifyLawyer(lawyerId: string, message: string) {
    this.logger.log(`Notify lawyer ${lawyerId}: ${message}`);
  }

  async notifyClient(clientId: string, message: string) {
    this.logger.log(`Notify client ${clientId}: ${message}`);
  }
}
