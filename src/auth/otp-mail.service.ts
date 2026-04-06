import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class OtpMailService {
  private readonly logger = new Logger(OtpMailService.name);
  private transporter?: nodemailer.Transporter;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST')?.trim();
    const portRaw = this.configService.get<string>('SMTP_PORT', '587') || '587';
    const port = Number.parseInt(portRaw, 10);
    const user = this.configService.get<string>('SMTP_USER')?.trim();
    const pass = this.configService.get<string>('SMTP_PASS');

    if (Number.isNaN(port)) {
      this.logger.warn(
        `SMTP not configured — invalid SMTP_PORT value "${portRaw}". OTP codes will be logged to console only`,
      );
      return;
    }
    
    if (host && user && pass) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass },
      });
      this.logger.log(
        `SMTP configured on ${host}:${port} (secure=${port === 465})`,
      );
    } else {
      const missing: string[] = [];
      if (!host) missing.push('SMTP_HOST');
      if (!user) missing.push('SMTP_USER');
      if (!pass) missing.push('SMTP_PASS');
      this.logger.warn(
        `SMTP not configured (missing: ${missing.join(', ')}) — OTP codes will be logged to console only`,
      );
    }
  }

  generateOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }
  async sendOtp(email: string, otp: string): Promise<void> {
    const subject = 'Lawvera - Email Verification Code';
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #fbf7f0; border-radius: 12px;">
        <h2 style="color: #1B3A5C; margin-bottom: 8px;">Lawvera</h2>
        <p style="color: #333; font-size: 15px;">Your email verification code is:</p>
        <div style="text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1B3A5C; background: #f3e2c1; padding: 12px 24px; border-radius: 8px;">${otp}</span>
        </div>
        <p style="color: #666; font-size: 13px;">This code expires in 10 minutes. If you did not request this, please ignore this email.</p>
      </div>
    `;

    if (this.transporter) {
      const from = this.configService.get<string>(
        'SMTP_FROM',
        `Lawvera <${this.configService.get<string>('SMTP_USER')}>`,
      );
      const info = await this.transporter.sendMail({
        from,
        to: email,
        subject,
        html,
      });
      this.logger.log(`OTP email sent to ${email} (messageId: ${info.messageId})`);
    } else {
      this.logger.warn(`[DEV] OTP for ${email}: ${otp}`);
    }
  }
}
