import type { CredentialsRepository, Credential, NewCredentialInput, NewEmailVerificationInput, NewPasswordResetInput } from "../../core/auth/credentials-repository.interface";
import type { TenantContext } from "../../core/context";
import type { AtomicBatchDatabaseProvider, Row } from "../../core/database";
import { isRole } from "../../core/rbac";

export class SqlCredentialsRepository implements CredentialsRepository {
  constructor(private readonly db: AtomicBatchDatabaseProvider) {}

  async findByEmail(tenant: TenantContext, email: string): Promise<Credential | null> {
    const { rows } = await this.db.query<CredentialRow>(
      `select user_id, tenant_id, email, password_hash, role, session_version, verified_at from credentials where tenant_id = $1 and email = $2 limit 1`,
      [tenant.tenantId, email],
    );
    return rows[0] ? toCredential(rows[0]) : null;
  }

  async findByUserId(tenant: TenantContext, userId: string): Promise<Credential | null> {
    const { rows } = await this.db.query<CredentialRow>(
      `select user_id, tenant_id, email, password_hash, role, session_version, verified_at from credentials where tenant_id = $1 and user_id = $2 limit 1`,
      [tenant.tenantId, userId],
    );
    return rows[0] ? toCredential(rows[0]) : null;
  }

  async create(tenant: TenantContext, input: NewCredentialInput): Promise<Credential> {
    const { rows } = await this.db.query<CredentialRow>(
      `insert into credentials (user_id, tenant_id, email, password_hash, role, verified_at) values ($1, $2, $3, $4, $5, $6) returning user_id, tenant_id, email, password_hash, role, session_version, verified_at`,
      [input.userId, tenant.tenantId, input.email, input.passwordHash, input.role, input.verifiedAt],
    );
    if (!rows[0]) throw new Error("Credentials insert returned no row");
    return toCredential(rows[0]);
  }

  async createPasswordReset(tenant: TenantContext, input: NewPasswordResetInput): Promise<void> {
    await this.db.batch([
      { sql: `update password_reset_tokens set used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where tenant_id = $1 and user_id = $2 and used_at is null`, params: [tenant.tenantId, input.userId] },
      { sql: `insert into password_reset_tokens (token_hash, tenant_id, user_id, email, expires_at) values ($1, $2, $3, $4, $5)`, params: [input.tokenHash, tenant.tenantId, input.userId, input.email, input.expiresAt] },
    ]);
  }

  async findUsablePasswordReset(tenant: TenantContext, tokenHash: string): Promise<{ userId: string; email: string } | null> {
    return this.findUsableToken("password_reset_tokens", tenant, tokenHash);
  }

  async redeemPasswordReset(tenant: TenantContext, tokenHash: string, userId: string, passwordHash: string): Promise<boolean> {
    const redemptionId = crypto.randomUUID();
    const results = await this.db.batch([
      { sql: `update password_reset_tokens set used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), redemption_id = $4 where token_hash = $1 and tenant_id = $2 and user_id = $3 and used_at is null and expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, params: [tokenHash, tenant.tenantId, userId, redemptionId] },
      { sql: `update credentials set password_hash = $4, session_version = session_version + 1 where tenant_id = $1 and user_id = $2 and exists (select 1 from password_reset_tokens where token_hash = $3 and tenant_id = $1 and user_id = $2 and redemption_id = $5)`, params: [tenant.tenantId, userId, tokenHash, passwordHash, redemptionId] },
    ]);
    return results[0]?.rowCount === 1 && results[1]?.rowCount === 1;
  }

  async createEmailVerification(tenant: TenantContext, input: NewEmailVerificationInput): Promise<void> {
    await this.db.batch([
      { sql: `update email_verification_tokens set used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where tenant_id = $1 and user_id = $2 and used_at is null`, params: [tenant.tenantId, input.userId] },
      { sql: `insert into email_verification_tokens (token_hash, tenant_id, user_id, email, expires_at) values ($1, $2, $3, $4, $5)`, params: [input.tokenHash, tenant.tenantId, input.userId, input.email, input.expiresAt] },
    ]);
  }

  async findUsableEmailVerification(tenant: TenantContext, tokenHash: string): Promise<{ userId: string; email: string } | null> {
    return this.findUsableToken("email_verification_tokens", tenant, tokenHash);
  }

  async redeemEmailVerification(tenant: TenantContext, tokenHash: string, userId: string): Promise<boolean> {
    const redemptionId = crypto.randomUUID();
    const results = await this.db.batch([
      { sql: `update email_verification_tokens set used_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), redemption_id = $4 where token_hash = $1 and tenant_id = $2 and user_id = $3 and used_at is null and expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, params: [tokenHash, tenant.tenantId, userId, redemptionId] },
      { sql: `update credentials set verified_at = coalesce(verified_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), session_version = session_version + 1 where tenant_id = $1 and user_id = $2 and exists (select 1 from email_verification_tokens where token_hash = $3 and tenant_id = $1 and user_id = $2 and redemption_id = $4)`, params: [tenant.tenantId, userId, tokenHash, redemptionId] },
    ]);
    return results[0]?.rowCount === 1 && results[1]?.rowCount === 1;
  }

  async revokeSessions(tenant: TenantContext, userId: string): Promise<void> {
    await this.db.query(`update credentials set session_version = session_version + 1 where tenant_id = $1 and user_id = $2`, [tenant.tenantId, userId]);
  }

  private async findUsableToken(table: "password_reset_tokens" | "email_verification_tokens", tenant: TenantContext, tokenHash: string) {
    const { rows } = await this.db.query<TokenRow>(
      `select user_id, email from ${table} where token_hash = $1 and tenant_id = $2 and used_at is null and expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') limit 1`,
      [tokenHash, tenant.tenantId],
    );
    return rows[0] ? { userId: rows[0].user_id, email: rows[0].email } : null;
  }
}

interface CredentialRow extends Row { user_id: string; tenant_id: string; email: string; password_hash: string; role: string; session_version: number; verified_at: string | null; }
interface TokenRow extends Row { user_id: string; email: string; }

function toCredential(row: CredentialRow): Credential {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    email: row.email,
    passwordHash: row.password_hash,
    role: isRole(row.role) ? row.role : "member",
    sessionVersion: Number(row.session_version),
    verifiedAt: row.verified_at,
  };
}
