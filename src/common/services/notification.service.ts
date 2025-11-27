import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  async notifyLawyer(lawyerId: string, message: string) {
    this.logger.log(`Notify lawyer ${lawyerId}: ${message}`);
  }

  async notifyClient(clientId: string, message: string) {
    this.logger.log(`Notify client ${clientId}: ${message}`);
  }
}

