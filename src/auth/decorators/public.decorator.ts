import { SetMetadata } from '@nestjs/common';
import { IS_PUBLIC_KEY } from '../auth.constants';

/** Mark a route handler as publicly reachable (no JWT required). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
