import {
  BadGatewayException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

type PayPalEnvironment = 'sandbox' | 'live';

type PayPalRequestOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
};

export type CreatePayPalOrderInput = {
  amountMinor: number;
  brandName: string;
  caseId: string;
  checkoutMode: 'wallet' | 'card';
  cancelUrl?: string;
  currency: string;
  description: string;
  invoiceId: string;
  returnUrl?: string;
};

export type PayPalOrderResult = {
  approvalUrl?: string;
  orderId: string;
  raw: Record<string, any>;
};

export type PayPalCaptureResult = {
  captureId: string;
  orderId: string;
  payerEmail?: string;
  payerId?: string;
  raw: Record<string, any>;
};

export type CreatePayPalPayoutInput = {
  amountMinor: number;
  currency: string;
  note: string;
  recipientEmail: string;
  senderBatchId: string;
  senderItemId: string;
  subject: string;
};

export type PayPalPayoutResult = {
  batchId?: string;
  itemId?: string;
  status?: string;
  raw: Record<string, any>;
};

export type PayPalRefundResult = {
  refundId?: string;
  status?: string;
  raw: Record<string, any>;
};

@Injectable()
export class PaypalEscrowService {
  private readonly logger = new Logger(PaypalEscrowService.name);
  private accessTokenCache?: {
    accessToken: string;
    expiresAt: number;
  };

  constructor(private readonly configService: ConfigService) {}

  getDefaultCurrency() {
    return (
      this.configService.get<string>('PAYPAL_DEFAULT_CURRENCY')?.trim().toUpperCase() ||
      'PHP'
    );
  }

  getBrandName() {
    return this.configService.get<string>('PAYPAL_BRAND_NAME')?.trim() || 'Lawvera';
  }

  getClientId() {
    return this.configService.get<string>('PAYPAL_CLIENT_ID')?.trim();
  }

  async createCheckoutOrder(
    input: CreatePayPalOrderInput,
  ): Promise<PayPalOrderResult> {
    const paymentSource =
      input.checkoutMode === 'card'
        ? {
            card: {
              attributes: {
                verification: {
                  method: 'SCA_WHEN_REQUIRED',
                },
              },
            },
          }
        : {
            paypal: {
              experience_context: {
                brand_name: input.brandName,
                user_action: 'PAY_NOW',
                return_url: input.returnUrl,
                cancel_url: input.cancelUrl,
              },
            },
          };

    const response = await this.request<Record<string, any>>(
      '/v2/checkout/orders',
      {
        method: 'POST',
        headers: {
          Prefer: 'return=representation',
          'PayPal-Request-Id': `lawvera-order-${input.caseId}-${Date.now()}`,
        },
        body: {
          intent: 'CAPTURE',
          purchase_units: [
            {
              reference_id: input.caseId,
              custom_id: input.caseId,
              invoice_id: input.invoiceId,
              description: input.description,
              amount: {
                currency_code: input.currency,
                value: this.minorToValue(input.amountMinor),
              },
            },
          ],
          payment_source: paymentSource,
        },
      },
    );

    const approvalUrl = Array.isArray(response.links)
      ? response.links.find(
          (link: any) =>
            link?.rel === 'approve' || link?.rel === 'payer-action',
        )?.href
      : undefined;

    if (!response.id) {
      this.logger.error(
        `PayPal order response did not include an order ID. Status: ${
          response.status || 'unknown'
        }. Payload: ${JSON.stringify(response)}`,
      );
      throw new BadGatewayException('PayPal did not return an order ID.');
    }

    if (input.checkoutMode === 'wallet' && !approvalUrl) {
      this.logger.error(
        `PayPal order ${response.id || 'unknown'} did not include an approval URL. Status: ${
          response.status || 'unknown'
        }. Links: ${JSON.stringify(response.links || [])}`,
      );
      throw new BadGatewayException(
        'PayPal did not return a checkout approval link.',
      );
    }

    return {
      orderId: response.id,
      approvalUrl,
      raw: response,
    };
  }

  async captureOrder(orderId: string, requestId: string) {
    const response = await this.request<Record<string, any>>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
      {
        method: 'POST',
        headers: {
          Prefer: 'return=representation',
          'PayPal-Request-Id': requestId,
        },
        body: {},
      },
    );

    const capture = response.purchase_units?.[0]?.payments?.captures?.[0];
    if (!capture?.id) {
      throw new BadGatewayException(
        'PayPal captured the order but no capture ID was returned.',
      );
    }

    return {
      captureId: capture.id,
      orderId: response.id || orderId,
      payerId: response.payer?.payer_id,
      payerEmail: response.payer?.email_address,
      raw: response,
    } satisfies PayPalCaptureResult;
  }

  async createPayout(input: CreatePayPalPayoutInput) {
    const response = await this.request<Record<string, any>>(
      '/v1/payments/payouts',
      {
        method: 'POST',
        headers: {
          Prefer: 'return=representation',
          'PayPal-Request-Id': input.senderBatchId,
        },
        body: {
          sender_batch_header: {
            sender_batch_id: input.senderBatchId,
            email_subject: input.subject,
            email_message: input.note,
          },
          items: [
            {
              recipient_type: 'EMAIL',
              amount: {
                value: this.minorToValue(input.amountMinor),
                currency: input.currency,
              },
              receiver: input.recipientEmail,
              note: input.note,
              sender_item_id: input.senderItemId,
            },
          ],
        },
      },
    );

    return {
      batchId: response.batch_header?.payout_batch_id,
      itemId: response.items?.[0]?.payout_item_id,
      status: response.batch_header?.batch_status,
      raw: response,
    } satisfies PayPalPayoutResult;
  }

  async refundCapture(
    captureId: string,
    requestId: string,
    note?: string,
  ): Promise<PayPalRefundResult> {
    const response = await this.request<Record<string, any>>(
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        method: 'POST',
        headers: {
          Prefer: 'return=representation',
          'PayPal-Request-Id': requestId,
        },
        body: note
          ? {
              note_to_payer: note.slice(0, 255),
            }
          : {},
      },
    );

    return {
      refundId: response.id,
      status: response.status,
      raw: response,
    };
  }

  async verifyWebhookSignature(
    headers: Record<string, string | string[] | undefined>,
    event: Record<string, any>,
  ) {
    const webhookId = this.configService.get<string>('PAYPAL_WEBHOOK_ID')?.trim();
    if (!webhookId) {
      throw new InternalServerErrorException(
        'PAYPAL_WEBHOOK_ID is not configured.',
      );
    }

    const response = await this.request<Record<string, any>>(
      '/v1/notifications/verify-webhook-signature',
      {
        method: 'POST',
        body: {
          auth_algo: this.getHeader(headers, 'paypal-auth-algo'),
          cert_url: this.getHeader(headers, 'paypal-cert-url'),
          transmission_id: this.getHeader(
            headers,
            'paypal-transmission-id',
          ),
          transmission_sig: this.getHeader(
            headers,
            'paypal-transmission-sig',
          ),
          transmission_time: this.getHeader(
            headers,
            'paypal-transmission-time',
          ),
          webhook_id: webhookId,
          webhook_event: event,
        },
      },
    );

    return response.verification_status === 'SUCCESS';
  }

  async verifyIpn(rawBody: string) {
    const url = this.isLive()
      ? 'https://ipnpb.paypal.com/cgi-bin/webscr'
      : 'https://ipnpb.sandbox.paypal.com/cgi-bin/webscr';
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Lawvera-PayPal-IPN-Listener',
      },
      body: `cmd=_notify-validate&${rawBody}`,
    });

    return (await response.text()).trim();
  }

  async generateClientToken() {
    const response = await this.request<Record<string, any>>(
      '/v1/identity/generate-token',
      {
        method: 'POST',
        body: {},
      },
    );

    if (!response.client_token) {
      throw new BadGatewayException(
        'PayPal did not return a client token for card checkout.',
      );
    }

    return response.client_token as string;
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    key: string,
  ) {
    const value = headers[key];
    if (Array.isArray(value)) {
      return value[0];
    }

    if (!value) {
      throw new BadGatewayException(
        `Missing PayPal webhook header: ${key.toUpperCase()}`,
      );
    }

    return value;
  }

  private async request<T>(
    path: string,
    options: PayPalRequestOptions = {},
  ): Promise<T> {
    const accessToken = await this.getAccessToken();
    const response = await fetch(`${this.getBaseUrl()}${path}`, {
      method: options.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const rawText = await response.text();
    const payload = rawText ? this.safeParseJson(rawText) : null;

    if (!response.ok) {
      const message =
        (payload &&
          typeof payload === 'object' &&
          payload !== null &&
          Array.isArray((payload as any).details) &&
          (payload as any).details[0]?.description) ||
        (payload &&
          typeof payload === 'object' &&
          payload !== null &&
          ((payload as any).message || (payload as any).error_description)) ||
        `PayPal request failed with status ${response.status}`;
      this.logger.error(`PayPal API error on ${path}: ${message}`);
      throw new BadGatewayException(message);
    }

    return (payload || {}) as T;
  }

  private async getAccessToken() {
    const cached = this.accessTokenCache;
    if (cached && cached.expiresAt > Date.now() + 30_000) {
      return cached.accessToken;
    }

    const clientId = this.configService.get<string>('PAYPAL_CLIENT_ID')?.trim();
    const clientSecret = this.configService.get<string>('PAYPAL_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException(
        'PayPal API credentials are not configured.',
      );
    }

    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
      'base64',
    );

    const response = await fetch(`${this.getBaseUrl()}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const rawText = await response.text();
    const payload = rawText ? this.safeParseJson(rawText) : null;
    if (!response.ok || !payload?.access_token) {
      const message =
        payload?.error_description ||
        payload?.error ||
        'Failed to get PayPal access token.';
      throw new BadGatewayException(message);
    }

    const expiresInSeconds = Number(payload.expires_in || 300);
    this.accessTokenCache = {
      accessToken: payload.access_token,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };

    return payload.access_token as string;
  }

  private getBaseUrl() {
    return this.isLive()
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  }

  private isLive() {
    const environment =
      (this.configService.get<string>('PAYPAL_ENV')?.trim().toLowerCase() as
        | PayPalEnvironment
        | undefined) || 'sandbox';
    return environment === 'live';
  }

  private minorToValue(amountMinor: number) {
    return (amountMinor / 100).toFixed(2);
  }

  private safeParseJson(text: string): Record<string, any> | null {
    try {
      return JSON.parse(text) as Record<string, any>;
    } catch {
      return null;
    }
  }
}
