import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * HTTP 402 Payment Required — used to surface seat-limit exhaustion.
 * The frontend keys on this status to render the upgrade CTA.
 */
export class SeatLimitReachedException extends HttpException {
  constructor(message: string, public readonly detail: Record<string, unknown>) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'SeatLimitReached',
        message,
        ...detail,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
