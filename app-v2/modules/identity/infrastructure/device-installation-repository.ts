/**
 * SQL implementation of `DeviceInstallationRepositoryPort` over
 * `DatabaseProvider`.
 *
 * Schema: db/migrations/d1/0001_identity.sql, table `device_installations`
 * (`account_id` NOT NULL, unique on `(user_id, device_id)`). Unlike the
 * other identity ports, `upsert`'s input (`NewDeviceInstallationRecord`)
 * carries `accountId` directly, so this one is scoped the ordinary way, no
 * derivation needed.
 */
import type { DatabaseProvider, Row } from "@nexara/core/database";
import type { TenantId, UserId } from "@shared/types";
import type {
  DeviceInstallationRecord,
  DeviceInstallationRepositoryPort,
  NewDeviceInstallationRecord,
} from "../application/ports";
import { nowIso, nullableText, text } from "./sql-helpers";

const DEVICE_COLUMNS =
  "id, user_id, account_id, platform, push_token, device_id, app_version, last_seen_at, enabled";

function toDeviceInstallationRecord(row: Row): DeviceInstallationRecord {
  return {
    id: text(row.id),
    userId: text(row.user_id) as UserId,
    accountId: text(row.account_id) as TenantId,
    platform: text(row.platform),
    pushToken: nullableText(row.push_token),
    deviceId: text(row.device_id),
    appVersion: nullableText(row.app_version),
    lastSeenAt: text(row.last_seen_at),
    enabled: Number(row.enabled) !== 0,
  };
}

export class SqlDeviceInstallationRepository implements DeviceInstallationRepositoryPort {
  constructor(private readonly db: DatabaseProvider) {}

  async upsert(input: NewDeviceInstallationRecord): Promise<DeviceInstallationRecord> {
    const id = crypto.randomUUID();
    // `NewDeviceInstallationRecord` carries no `lastSeenAt` — an upsert IS
    // the device checking in, so "now" is the accurate value, not a
    // fabricated one; `DeviceInstallationRecord.lastSeenAt` is non-nullable
    // and the column has no default, so something must be written here.
    const seenAt = nowIso();
    await this.db.query(
      `insert into device_installations
         (id, user_id, account_id, platform, push_token, device_id, app_version, last_seen_at, enabled)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict(user_id, device_id) do update set
         account_id = excluded.account_id,
         platform = excluded.platform,
         push_token = excluded.push_token,
         app_version = excluded.app_version,
         last_seen_at = excluded.last_seen_at,
         enabled = excluded.enabled`,
      [
        id,
        input.userId,
        input.accountId,
        input.platform,
        input.pushToken,
        input.deviceId,
        input.appVersion,
        seenAt,
        input.enabled ? 1 : 0,
      ],
    );

    const { rows } = await this.db.query<Row>(
      `select ${DEVICE_COLUMNS} from device_installations
        where account_id = $1 and user_id = $2 and device_id = $3`,
      [input.accountId, input.userId, input.deviceId],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("device installation upsert succeeded but the row could not be read back");
    }
    return toDeviceInstallationRecord(row);
  }

  async listForUser(userId: UserId): Promise<readonly DeviceInstallationRecord[]> {
    const { rows } = await this.db.query<Row>(
      `select ${DEVICE_COLUMNS} from device_installations
        where user_id = $1 and account_id is not null order by device_id`,
      [userId],
    );
    return rows.map(toDeviceInstallationRecord);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    // See user-repository.ts's findById/markEmailVerified for why this
    // predicate — not an equality filter — is what stands in for tenant
    // scoping when the port gives no tenant argument.
    await this.db.query(
      `update device_installations set enabled = $2 where id = $1 and account_id is not null`,
      [id, enabled ? 1 : 0],
    );
  }

  async touch(id: string, lastSeenAt: string): Promise<void> {
    await this.db.query(
      `update device_installations set last_seen_at = $2 where id = $1 and account_id is not null`,
      [id, lastSeenAt],
    );
  }
}
