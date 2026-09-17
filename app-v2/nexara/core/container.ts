import { AppError } from "../shared/errors";
import type { AuthProvider } from "./auth";
import type { AtomicBatchDatabaseProvider, DatabaseProvider } from "./database";
import type { PlatformProvider } from "./platform";
import { PermissionService } from "./rbac";
import type { ProfileRepository, UserRepository } from "./repositories";
import type { EventBus } from "./events";
import type { StorageProvider } from "./storage";
import type { EmailProvider } from "./email";

// Concrete providers + infrastructure are imported ONLY here, in the
// composition root.
import { CloudflarePlatformProvider, type CloudflareBindings } from "./platform/providers/cloudflare-platform-provider";
import { D1DatabaseProvider, type D1DatabaseBinding } from "./database/providers/d1-database-provider";
import { PostgresDatabaseProvider } from "./database/providers/postgres-database-provider";
import { JwtAuthProvider } from "./auth/providers/jwt-auth-provider";
import { R2StorageProvider, type R2BucketBinding } from "./storage/providers/r2-storage-provider";
import { BrevoEmailProvider } from "./email/providers/brevo-email-provider";
import { ConsoleEmailProvider } from "./email/providers/console-email-provider";
import { parseRecipientAllowlist, RecipientAllowlistEmailProvider } from "./email/providers/recipient-allowlist-email-provider";
import { ResendEmailProvider } from "./email/providers/resend-email-provider";
import { SesEmailProvider } from "./email/providers/ses-email-provider";
import { UnavailableEmailProvider } from "./email/providers/unavailable-email-provider";
import { SqlProfileRepository, SqlUserRepository, SqlCredentialsRepository, InMemoryEventBus } from "../infrastructure";

/**
 * Dependency Injection — the composition root.
 *
 * This is the ONLY module in the codebase that imports concrete provider
 * implementations. Business logic and features receive the interfaces below and
 * never know which provider is behind them. To migrate (D1 → Postgres,
 * Cloudflare → AWS), change the wiring here — nothing else.
 */
/** Tenant-scoped data-access contracts (interfaces only; impls in infrastructure). */
export interface Repositories {
  readonly profiles: ProfileRepository;
  readonly users: UserRepository;
}

export interface Services {
  readonly platform: PlatformProvider;
  readonly database: DatabaseProvider;
  readonly auth: AuthProvider;
  readonly permissions: PermissionService;
  readonly repositories: Repositories;
  readonly events: EventBus;
  readonly storage?: StorageProvider;
  readonly email?: EmailProvider;
}

/**
 * Build the service container from the platform environment.
 *
 * @param env Cloudflare bindings (env vars + KV/Queue). Obtained from the
 *            request context (`getCloudflareContext().env`) at the edge.
 */
export function createServices(env: CloudflareBindings): Services {
  // 1. Platform — selected first; everything else reads config through it.
  const platform = createPlatformProvider(env);

  // 2. RBAC — pure, provider-independent.
  const permissions = new PermissionService();

  // 3. Database.
  const database = createDatabaseProvider(platform, env);

  // 4. Auth — depends on RBAC for permission verification.
  const auth = createAuthProvider(platform, database, permissions);

  // 5. Repositories — domain data-access over the DatabaseProvider. Concrete
  //    implementations come from infrastructure; services see interfaces only.
  const repositories: Repositories = {
    profiles: new SqlProfileRepository(database),
    users: new SqlUserRepository(database),
  };

  // 6. Event bus — in-process pub/sub. Register module event handlers here at
  //    composition time (e.g. events.subscribe("UserCreated", handler)).
  const events: EventBus = new InMemoryEventBus();

  // 7. Optional media storage. Applications opt in with STORAGE_PROVIDER=r2.
  const storage = createStorageProvider(platform, env);
  const email = createEmailProvider(platform);

  return { platform, database, auth, permissions, repositories, events, storage, email };
}

function createPlatformProvider(env: CloudflareBindings): PlatformProvider {
  const which = (typeof env.PLATFORM_PROVIDER === "string" ? env.PLATFORM_PROVIDER : "cloudflare").toLowerCase();
  switch (which) {
    case "cloudflare":
      return new CloudflarePlatformProvider(env);
    // case "aws": return new AWSPlatformProvider(env);  // future
    default:
      throw AppError.platform(`Unsupported PLATFORM_PROVIDER: ${which}`);
  }
}

function createDatabaseProvider(
  platform: PlatformProvider,
  env: CloudflareBindings,
): DatabaseProvider {
  // No Supabase adapter exists by design — see docs SUPABASE_EXIT_PLAN.md.
  // The operational store is not locked yet (DATABASE_DECISION.md gate);
  // both adapters are implemented and exercised by the same contract tests.
  const which = (platform.getEnv("DATABASE_PROVIDER") ?? "d1").toLowerCase();
  switch (which) {
    case "d1": {
      if (!env.DB) throw AppError.platform("Missing required D1 binding: DB");
      return new D1DatabaseProvider({ db: env.DB as D1DatabaseBinding });
    }
    case "postgres":
      return new PostgresDatabaseProvider({
        connectionString: platform.requireEnv("DATABASE_URL"),
      });
    default:
      throw AppError.database(`Unsupported DATABASE_PROVIDER: ${which}`);
  }
}

function createAuthProvider(
  platform: PlatformProvider,
  database: DatabaseProvider,
  permissions: PermissionService,
): AuthProvider {
  const which = (platform.getEnv("AUTH_PROVIDER") ?? "jwt").toLowerCase();
  switch (which) {
    case "jwt":
      if (!isAtomicBatchDatabaseProvider(database)) {
        throw AppError.provider("AUTH_PROVIDER=jwt requires a database provider with atomic batch support");
      }
      return new JwtAuthProvider(
        {
          secret: platform.requireEnv("AUTH_SECRET"),
          tenantId: platform.requireEnv("AUTH_TENANT_ID"),
          issuer: platform.requireEnv("AUTH_ISSUER"),
          audience: platform.requireEnv("AUTH_AUDIENCE"),
        },
        new SqlCredentialsRepository(database),
        permissions,
      );
    // case "betterauth": return new BetterAuthProvider({ ... }, permissions);  // future
    // case "clerk":      return new ClerkProvider({ ... }, permissions);       // future
    // case "auth0":      return new Auth0Provider({ ... }, permissions);       // future
    default:
      throw AppError.provider(`Unsupported AUTH_PROVIDER: ${which}`);
  }
}

function isAtomicBatchDatabaseProvider(
  database: DatabaseProvider,
): database is AtomicBatchDatabaseProvider {
  return "batch" in database && typeof database.batch === "function";
}

function createStorageProvider(
  platform: PlatformProvider,
  env: CloudflareBindings,
): StorageProvider | undefined {
  const which = platform.getEnv("STORAGE_PROVIDER")?.toLowerCase();
  if (!which) return undefined;
  switch (which) {
    case "r2": {
      if (!env.NEXARA_MEDIA) throw AppError.platform("Missing required R2 binding: NEXARA_MEDIA");
      return new R2StorageProvider({
        bucket: env.NEXARA_MEDIA as R2BucketBinding,
        publicOrigin: platform.requireEnv("MEDIA_PUBLIC_ORIGIN"),
      });
    }
    default:
      throw AppError.provider(`Unsupported STORAGE_PROVIDER: ${which}`);
  }
}

function createEmailProvider(platform: PlatformProvider): EmailProvider | undefined {
  const which = platform.getEnv("EMAIL_PROVIDER")?.toLowerCase();
  if (!which) return undefined;
  let provider: EmailProvider;

  switch (which) {
    case "console":
      provider = new ConsoleEmailProvider();
      break;
    case "unavailable":
      provider = new UnavailableEmailProvider();
      break;
    case "resend":
      provider = new ResendEmailProvider({
        apiKey: platform.requireEnv("RESEND_API_KEY"),
        from: platform.requireEnv("EMAIL_FROM"),
      });
      break;
    case "brevo":
      provider = new BrevoEmailProvider({
        apiKey: platform.requireEnv("BREVO_API_KEY"),
        fromEmail: platform.requireEnv("EMAIL_FROM_ADDRESS"),
        fromName: platform.requireEnv("EMAIL_FROM_NAME"),
      });
      break;
    case "ses":
      provider = new SesEmailProvider({
        region: platform.requireEnv("AWS_SES_REGION"),
        accessKeyId: platform.requireEnv("AWS_SES_ACCESS_KEY_ID"),
        secretAccessKey: platform.requireEnv("AWS_SES_SECRET_ACCESS_KEY"),
        from: platform.requireEnv("EMAIL_FROM"),
      });
      break;
    default:
      throw AppError.provider(`Unsupported EMAIL_PROVIDER: ${which}`);
  }

  if (platform.getEnv("APP_ENV") === "staging" && provider.name !== "console" && provider.name !== "unavailable") {
    return new RecipientAllowlistEmailProvider(
      provider,
      parseRecipientAllowlist(platform.requireEnv("STAGING_EMAIL_RECIPIENT_ALLOWLIST")),
    );
  }
  return provider;
}
