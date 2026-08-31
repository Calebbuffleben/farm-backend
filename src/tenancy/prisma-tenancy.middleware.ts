import type { Prisma } from '@prisma/client';
import { MissingTenantContextError } from './tenant-context.types';
import type { TenantContextService } from './tenant-context.service';

/**
 * Prisma v5 `$use` middleware that acts as a **fail-closed safety net** for
 * tenant isolation. It NEVER silently drops tenantId filters — if a call
 * targets a tenant-scoped model without `tenantId` and no HTTP ALS context
 * is available (and tenant bypass is not active), it throws.
 *
 * Services are still expected to pass `tenantId` explicitly (especially in
 * socket/WS/gRPC scopes, where ALS is intentionally NOT populated).
 */
const TENANT_SCOPED_MODELS = new Set<string>([
  // NOTE: `User` is intentionally excluded. Users are global identities —
  // a single email can be a member of many tenants. Tenant isolation for
  // user-related data is enforced via `Membership` (which IS scoped).
  'RefreshToken',
  'AuditLog',
  'Membership',
  'Invitation',
  'Subscription',
  // Canal WABA + Conversation Core
  'WabaAccount',
  'ChannelAccount',
  'ChannelEndpoint',
  'Conversation',
  'LogicalSession',
  'Message',
  'MediaAsset',
  // Domínio agro
  'Producer',
  'ProducerPhone',
  'ProducerEmail',
  'Farm',
  'CropSeason',
  'EntityLink',
  // Analítico
  'CommercialFact',
  'FarmState',
  'UnknownQueueItem',
  // LGPD
  'ConsentRecord',
]);

const WHERE_OPS = new Set<string>([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'updateMany',
  'deleteMany',
]);

const DATA_OPS = new Set<string>([
  'create',
  'createMany',
]);

/** findUnique/findUniqueOrThrow/delete/update use a unique where (often by id) —
 *  we do NOT inject tenantId there (it can break unique lookups). Services
 *  must call `findFirst` with explicit tenantId when cross-tenant leakage
 *  would otherwise be possible. */
const UNIQUE_WHERE_OPS = new Set<string>([
  'findUnique',
  'findUniqueOrThrow',
  'delete',
  'update',
]);

export function createTenancyMiddleware(
  tenantCtx: TenantContextService,
): Prisma.Middleware {
  return async (params, next) => {
    const model = params.model;
    if (!model || !TENANT_SCOPED_MODELS.has(model)) {
      return next(params);
    }

    if (tenantCtx.isBypassActive()) {
      return next(params);
    }

    const httpCtx = tenantCtx.getHttpContext();
    const httpTenantId = httpCtx?.tenantId;

    if (WHERE_OPS.has(params.action)) {
      const where = (params.args?.where ?? {}) as Record<string, unknown>;
      if (where.tenantId === undefined) {
        if (!httpTenantId) {
          throw new MissingTenantContextError(
            `${model}.${params.action} missing where.tenantId and no HTTP tenant context`,
          );
        }
        params.args = {
          ...(params.args ?? {}),
          where: { ...where, tenantId: httpTenantId },
        };
      }
      return next(params);
    }

    if (DATA_OPS.has(params.action)) {
      const data = params.args?.data as
        | Record<string, unknown>
        | Array<Record<string, unknown>>
        | undefined;
      if (Array.isArray(data)) {
        const missing = data.some((d) => d?.tenantId === undefined);
        if (missing) {
          if (!httpTenantId) {
            throw new MissingTenantContextError(
              `${model}.${params.action} missing data.tenantId and no HTTP tenant context`,
            );
          }
          params.args.data = data.map((d) =>
            d?.tenantId === undefined ? { ...d, tenantId: httpTenantId } : d,
          );
        }
      } else {
        if (!data || data.tenantId === undefined) {
          if (!httpTenantId) {
            throw new MissingTenantContextError(
              `${model}.${params.action} missing data.tenantId and no HTTP tenant context`,
            );
          }
          params.args = {
            ...(params.args ?? {}),
            data: { ...(data ?? {}), tenantId: httpTenantId },
          };
        }
      }
      return next(params);
    }

    if (params.action === 'upsert') {
      const where = (params.args?.where ?? {}) as Record<string, unknown>;
      const create = (params.args?.create ?? {}) as Record<string, unknown>;
      const update = (params.args?.update ?? {}) as Record<string, unknown>;
      if (
        where.tenantId === undefined ||
        create.tenantId === undefined ||
        update.tenantId === undefined
      ) {
        if (!httpTenantId) {
          throw new MissingTenantContextError(
            `${model}.upsert missing tenantId in where/create/update`,
          );
        }
        params.args = {
          ...(params.args ?? {}),
          where:
            where.tenantId === undefined
              ? { ...where, tenantId: httpTenantId }
              : where,
          create:
            create.tenantId === undefined
              ? { ...create, tenantId: httpTenantId }
              : create,
          update:
            update.tenantId === undefined
              ? { ...update, tenantId: httpTenantId }
              : update,
        };
      }
      return next(params);
    }

    if (UNIQUE_WHERE_OPS.has(params.action)) {
      // Pass-through by design (unique lookup by id). Callers must verify
      // the returned row's tenantId against their context.
      return next(params);
    }

    return next(params);
  };
}
