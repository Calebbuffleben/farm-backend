/**
 * In-memory PrismaService stand-in for e2e tests.
 *
 * Implements the slice of Prisma used by AuthService, MembersService,
 * InvitationsService, BillingService, FeedbackService and PlaybookTemplatesService
 * exercise the full HTTP/auth/membership stack without a real Postgres.
 *
 * This is intentionally narrow: if you touch a new Prisma call path in
 * a test, add it here explicitly so we stay fail-loud.
 *
 * NOTE: signatures mimic Prisma's delegate shape (`findUnique`, `create`, …)
 * but cut corners on select/include — we return full objects (plus a
 * `user` nested object where Membership.findMany/change-role need it).
 */

type Id = string;

interface TenantRow {
  id: Id;
  slug: string;
  name: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'DELETED';
  createdAt: Date;
  updatedAt: Date;
}

interface UserRow {
  id: Id;
  email: string;
  passwordHash: string | null;
  name: string | null;
  isActive: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface MembershipRow {
  id: Id;
  userId: Id;
  tenantId: Id;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
  invitedBy: Id | null;
  createdAt: Date;
  updatedAt: Date;
}

interface InvitationRow {
  id: Id;
  tenantId: Id;
  email: string;
  role: 'OWNER' | 'ADMIN' | 'MANAGER' | 'MEMBER';
  tokenHash: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  invitedById: Id;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface SubscriptionRow {
  id: Id;
  tenantId: Id;
  plan: 'FREE' | 'PRO' | 'ENTERPRISE';
  maxUsers: number;
  status: 'ACTIVE' | 'CANCELED' | 'PAST_DUE';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripePriceId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface RefreshTokenRow {
  id: Id;
  tenantId: Id;
  userId: Id;
  membershipId: Id | null;
  tokenHash: string;
  familyId: Id;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: Id | null;
  createdByIp: string | null;
  userAgent: string | null;
  createdAt: Date;
}

interface AuditLogRow {
  id: Id;
  tenantId: Id | null;
  userId: Id | null;
  action: string;
  target: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

interface FeedbackEventRow {
  id: Id;
  tenantId: Id;
  meetingId: string;
  participantId: string;
  type: string;
  severity: string;
  ts: Date;
  windowStart: Date;
  windowEnd: Date;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: Date;
  expiresAt: Date | null;
}

interface PlaybookTemplateRow {
  id: Id;
  tenantId: Id;
  key: string;
  title: string;
  description: string | null;
  steps: unknown;
  createdAt: Date;
  updatedAt: Date;
}

function uid(prefix = ''): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

function matchWhere<T extends Record<string, any>>(
  row: T,
  where: Record<string, any> | undefined,
): boolean {
  if (!where) return true;
  for (const [key, value] of Object.entries(where)) {
    if (key === 'AND') {
      if (!Array.isArray(value)) continue;
      if (!value.every((sub) => matchWhere(row, sub))) return false;
      continue;
    }
    if (key === 'OR') {
      if (!Array.isArray(value)) continue;
      if (!value.some((sub) => matchWhere(row, sub))) return false;
      continue;
    }
    if (key === 'NOT') {
      if (matchWhere(row, value as Record<string, any>)) return false;
      continue;
    }
    if (key === 'metadata' && value && typeof value === 'object' && 'path' in value) {
      const path = (value as any).path as string[];
      const wanted = (value as any).equals;
      let cur: any = row[key];
      for (const p of path) {
        cur = cur?.[p];
      }
      if (cur !== wanted) return false;
      continue;
    }
    if (key === 'createdAt' && value && typeof value === 'object') {
      const gte = (value as any).gte;
      if (gte && !(row[key] >= gte)) return false;
      continue;
    }
    if (key === 'userId_tenantId' && value && typeof value === 'object') {
      if (
        row.userId !== (value as any).userId ||
        row.tenantId !== (value as any).tenantId
      ) {
        return false;
      }
      continue;
    }
    if (key === 'tenantId_key' && value && typeof value === 'object') {
      if (
        (row as any).tenantId !== (value as any).tenantId ||
        (row as any).key !== (value as any).key
      ) {
        return false;
      }
      continue;
    }
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      // Unsupported deep filter — fall through and compare loosely.
      if (JSON.stringify(row[key]) !== JSON.stringify(value)) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

export function createInMemoryPrismaFake() {
  const tenants: TenantRow[] = [];
  const users: UserRow[] = [];
  const memberships: MembershipRow[] = [];
  const invitations: InvitationRow[] = [];
  const subscriptions: SubscriptionRow[] = [];
  const pendingCheckouts: Array<Record<string, any>> = [];
  const refreshTokens: RefreshTokenRow[] = [];
  const auditLogs: AuditLogRow[] = [];
  const feedbackEvents: FeedbackEventRow[] = [];
  const playbookTemplates: PlaybookTemplateRow[] = [];

  const api = {
    async $transaction(fn: (tx: typeof api) => Promise<unknown>) {
      return fn(api);
    },

    // -------------------------- Tenant -------------------------------- //
    tenant: {
      async findUnique({ where }: any) {
        return tenants.find((t) => matchWhere(t, where)) ?? null;
      },
      async create({ data }: any) {
        const row: TenantRow = {
          id: uid('tnt_'),
          slug: data.slug,
          name: data.name,
          status: data.status ?? 'ACTIVE',
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        tenants.push(row);
        return row;
      },
    },

    // -------------------------- User ---------------------------------- //
    user: {
      async findUnique({ where, select }: any) {
        const row = users.find((u) => matchWhere(u, where)) ?? null;
        if (!row || !select) return row;
        const out: any = {};
        for (const k of Object.keys(select)) {
          if (select[k]) out[k] = (row as any)[k];
        }
        return out;
      },
      async count({ where }: any) {
        return users.filter((u) => matchWhere(u, where)).length;
      },
      async create({ data }: any) {
        const row: UserRow = {
          id: uid('usr_'),
          email: data.email,
          passwordHash: data.passwordHash ?? null,
          name: data.name ?? null,
          isActive: data.isActive ?? true,
          lastLoginAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        users.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const idx = users.findIndex((u) => matchWhere(u, where));
        if (idx < 0) throw new Error('user not found');
        users[idx] = { ...users[idx], ...data, updatedAt: new Date() };
        return users[idx];
      },
    },

    // -------------------------- Membership ---------------------------- //
    membership: {
      async findUnique({ where, include }: any) {
        const row = memberships.find((m) => matchWhere(m, where)) ?? null;
        if (!row) return null;
        if (include?.user) {
          const user = users.find((u) => u.id === row.userId) ?? null;
          return { ...row, user };
        }
        return row;
      },
      async findFirst({ where }: any) {
        return memberships.find((m) => matchWhere(m, where)) ?? null;
      },
      async findMany({ where, include, orderBy }: any) {
        let rows = memberships.filter((m) => matchWhere(m, where));
        if (orderBy?.createdAt === 'asc') {
          rows = rows.slice().sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          );
        }
        if (include?.user) {
          return rows.map((r) => ({
            ...r,
            user: users.find((u) => u.id === r.userId) ?? null,
          }));
        }
        return rows;
      },
      async count({ where }: any) {
        return memberships.filter((m) => matchWhere(m, where)).length;
      },
      async create({ data, include }: any) {
        const row: MembershipRow = {
          id: uid('mbr_'),
          userId: data.userId,
          tenantId: data.tenantId,
          role: data.role ?? 'MEMBER',
          invitedBy: data.invitedBy ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        memberships.push(row);
        if (include?.user) {
          return { ...row, user: users.find((u) => u.id === row.userId) ?? null };
        }
        return row;
      },
      async update({ where, data, include }: any) {
        const idx = memberships.findIndex((m) => matchWhere(m, where));
        if (idx < 0) throw new Error('membership not found');
        memberships[idx] = { ...memberships[idx], ...data, updatedAt: new Date() };
        const row = memberships[idx];
        if (include?.user) {
          return { ...row, user: users.find((u) => u.id === row.userId) ?? null };
        }
        return row;
      },
      async delete({ where }: any) {
        const idx = memberships.findIndex((m) => matchWhere(m, where));
        if (idx < 0) throw new Error('membership not found');
        const [removed] = memberships.splice(idx, 1);
        return removed;
      },
    },

    // -------------------------- Invitation ---------------------------- //
    invitation: {
      async findUnique({ where }: any) {
        return invitations.find((i) => matchWhere(i, where)) ?? null;
      },
      async findFirst({ where }: any) {
        return invitations.find((i) => matchWhere(i, where)) ?? null;
      },
      async findMany({ where, orderBy }: any) {
        let rows = invitations.filter((i) => matchWhere(i, where));
        if (orderBy?.createdAt === 'desc') {
          rows = rows.slice().sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }
        return rows;
      },
      async count({ where }: any) {
        return invitations.filter((i) => matchWhere(i, where)).length;
      },
      async create({ data }: any) {
        const row: InvitationRow = {
          id: uid('inv_'),
          tenantId: data.tenantId,
          email: data.email,
          role: data.role ?? 'MEMBER',
          tokenHash: data.tokenHash,
          status: data.status ?? 'PENDING',
          invitedById: data.invitedById,
          expiresAt: data.expiresAt,
          acceptedAt: data.acceptedAt ?? null,
          revokedAt: data.revokedAt ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        invitations.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const idx = invitations.findIndex((i) => matchWhere(i, where));
        if (idx < 0) throw new Error('invitation not found');
        invitations[idx] = { ...invitations[idx], ...data, updatedAt: new Date() };
        return invitations[idx];
      },
    },

    // -------------------------- Subscription -------------------------- //
    subscription: {
      async findUnique({ where }: any) {
        return subscriptions.find((s) => matchWhere(s, where)) ?? null;
      },
      async create({ data }: any) {
        const row: SubscriptionRow = {
          id: uid('sub_'),
          tenantId: data.tenantId,
          plan: data.plan ?? 'FREE',
          maxUsers: data.maxUsers ?? 3,
          status: data.status ?? 'ACTIVE',
          stripeCustomerId: data.stripeCustomerId ?? null,
          stripeSubscriptionId: data.stripeSubscriptionId ?? null,
          stripePriceId: data.stripePriceId ?? null,
          currentPeriodEnd: data.currentPeriodEnd ?? null,
          cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        subscriptions.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const idx = subscriptions.findIndex((s) => matchWhere(s, where));
        if (idx < 0) throw new Error('subscription not found');
        subscriptions[idx] = { ...subscriptions[idx], ...data, updatedAt: new Date() };
        return subscriptions[idx];
      },
    },

    pendingCheckout: {
      async findUnique({ where }: any) {
        return pendingCheckouts.find((p) => matchWhere(p, where)) ?? null;
      },
      async create({ data }: any) {
        const row = {
          id: uid('pco_'),
          email: data.email,
          passwordHash: data.passwordHash,
          name: data.name ?? null,
          tenantName: data.tenantName,
          tenantSlug: data.tenantSlug,
          plan: data.plan,
          stripeCheckoutSessionId: data.stripeCheckoutSessionId ?? null,
          status: data.status ?? 'PENDING',
          tenantId: data.tenantId ?? null,
          expiresAt: data.expiresAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        pendingCheckouts.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const idx = pendingCheckouts.findIndex((p) => matchWhere(p, where));
        if (idx < 0) throw new Error('pendingCheckout not found');
        pendingCheckouts[idx] = { ...pendingCheckouts[idx], ...data, updatedAt: new Date() };
        return pendingCheckouts[idx];
      },
    },

    // -------------------------- RefreshToken -------------------------- //
    refreshToken: {
      async findUnique({ where }: any) {
        return refreshTokens.find((r) => matchWhere(r, where)) ?? null;
      },
      async create({ data }: any) {
        const row: RefreshTokenRow = {
          id: data.id ?? uid('rt_'),
          tenantId: data.tenantId,
          userId: data.userId,
          membershipId: data.membershipId ?? null,
          tokenHash: data.tokenHash,
          familyId: data.familyId,
          expiresAt: data.expiresAt,
          revokedAt: null,
          replacedById: null,
          createdByIp: data.createdByIp ?? null,
          userAgent: data.userAgent ?? null,
          createdAt: new Date(),
        };
        refreshTokens.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const idx = refreshTokens.findIndex((r) => matchWhere(r, where));
        if (idx < 0) throw new Error('refresh token not found');
        refreshTokens[idx] = { ...refreshTokens[idx], ...data };
        return refreshTokens[idx];
      },
      async updateMany({ where, data }: any) {
        let count = 0;
        for (const r of refreshTokens) {
          if (matchWhere(r, where)) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      },
    },

    // -------------------------- AuditLog ------------------------------ //
    auditLog: {
      async create({ data }: any) {
        const row: AuditLogRow = {
          id: uid('al_'),
          tenantId: data.tenantId ?? null,
          userId: data.userId ?? null,
          action: data.action,
          target: data.target ?? null,
          ip: data.ip ?? null,
          userAgent: data.userAgent ?? null,
          metadata: data.metadata ?? null,
          createdAt: new Date(),
        };
        auditLogs.push(row);
        return row;
      },
      async count({ where }: any) {
        return auditLogs.filter((a) => matchWhere(a, where)).length;
      },
      async findMany({ where, take }: any) {
        const hits = auditLogs.filter((a) => matchWhere(a, where));
        return take ? hits.slice(0, take) : hits;
      },
      async update({ where, data }: any) {
        const idx = auditLogs.findIndex((a) => matchWhere(a, where));
        if (idx < 0) throw new Error('audit log not found');
        auditLogs[idx] = { ...auditLogs[idx], ...data };
        return auditLogs[idx];
      },
    },

    // -------------------------- FeedbackEvent ------------------------- //
    feedbackEvent: {
      async findMany({ where, take, orderBy }: any) {
        let rows = feedbackEvents.filter((f) => matchWhere(f, where));
        if (orderBy?.createdAt === 'desc') {
          rows = rows.slice().sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
          );
        }
        if (take) rows = rows.slice(0, take);
        return rows;
      },
      async findFirst({ where }: any) {
        return feedbackEvents.find((f) => matchWhere(f, where)) ?? null;
      },
      async count({ where }: any) {
        return feedbackEvents.filter((f) => matchWhere(f, where)).length;
      },
      async create({ data }: any) {
        const row: FeedbackEventRow = {
          id: data.id ?? uid('fb_'),
          tenantId: data.tenantId,
          meetingId: data.meetingId,
          participantId: data.participantId,
          type: data.type,
          severity: data.severity,
          ts: data.ts,
          windowStart: data.windowStart,
          windowEnd: data.windowEnd,
          message: data.message,
          metadata: data.metadata,
          createdAt: new Date(),
          expiresAt: data.expiresAt ?? null,
        };
        feedbackEvents.push(row);
        return row;
      },
      async aggregate() {
        return { _count: { _all: feedbackEvents.length } };
      },
      async groupBy() {
        return [];
      },
    },

    // -------------------------- PlaybookTemplate ---------------------- //
    playbookTemplate: {
      async findUnique({ where }: any) {
        return playbookTemplates.find((p) => matchWhere(p, where)) ?? null;
      },
      async findFirst({ where }: any) {
        return playbookTemplates.find((p) => matchWhere(p, where)) ?? null;
      },
      async findMany({ where, orderBy }: any) {
        let rows = playbookTemplates.filter((p) => matchWhere(p, where));
        if (orderBy?.key === 'asc') {
          rows = rows.slice().sort((a, b) => a.key.localeCompare(b.key));
        }
        return rows;
      },
      async create({ data }: any) {
        if (
          playbookTemplates.some(
            (p) => p.tenantId === data.tenantId && p.key === data.key,
          )
        ) {
          const err = new Error('Unique constraint failed');
          (err as { code?: string }).code = 'P2002';
          throw err;
        }
        const row: PlaybookTemplateRow = {
          id: uid('pbt_'),
          tenantId: data.tenantId,
          key: data.key,
          title: data.title,
          description: data.description ?? null,
          steps: data.steps,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        playbookTemplates.push(row);
        return row;
      },
      async update({ where, data }: any) {
        const idx = playbookTemplates.findIndex((p) => matchWhere(p, where));
        if (idx < 0) throw new Error('playbookTemplate not found');
        const cur = playbookTemplates[idx];
        playbookTemplates[idx] = {
          ...cur,
          ...data,
          updatedAt: new Date(),
        };
        return playbookTemplates[idx];
      },
      async delete({ where }: any) {
        const idx = playbookTemplates.findIndex((p) => matchWhere(p, where));
        if (idx < 0) throw new Error('playbookTemplate not found');
        const [removed] = playbookTemplates.splice(idx, 1);
        return removed;
      },
    },

    _dumpTenants: () => tenants.slice(),
    _dumpUsers: () => users.slice(),
    _dumpMemberships: () => memberships.slice(),
    _dumpInvitations: () => invitations.slice(),
    _dumpSubscriptions: () => subscriptions.slice(),
    _dumpRefreshTokens: () => refreshTokens.slice(),
    _dumpAuditLogs: () => auditLogs.slice(),
    _dumpFeedbackEvents: () => feedbackEvents.slice(),
    _dumpPlaybookTemplates: () => playbookTemplates.slice(),
  };

  return api;
}
