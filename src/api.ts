// Beaver Ops' API as the CLI sees it (src/app/api/cli/*, /api/me/*): JSON over HTTPS with the `bcli_`
// token, errors `{ error: { code, message } }` turned into messages that say what to do.
import type { Context } from "./context";
import { apiUrl } from "./config";
import { CliError, NotSignedInError } from "./errors";
import { compareVersions, VERSION } from "./version";

export type ConnectInfo = {
  gateway: { host: string; port: number };
  sshUser: string;
  pgUser: string;
  database: string;
  clusterHost: string;
  clusterPort: number;
  localPort: number;
  sslMode: "require" | "disable";
  engine: "pg" | "clickhouse";
  nativePort?: number;
  localNativePort?: number;
};

export type DbAccessRow = {
  grantId: string;
  ref: string;
  database: string;
  cluster: { name: string; provider: string; engine: string };
  environment: { projectName: string; name: string; projectSlug: string; slug: string } | null;
  level: "read" | "write";
  allowSchema: boolean;
  expiresAt: string | null;
  /** When and by whom the access was granted; missing on servers older than these fields. */
  grantedAt?: string;
  grantedBy?: { name: string | null; email: string } | null;
  /** Last tunnel the gateway opened for this access (null: never used). */
  lastConnectedAt?: string | null;
  status: string;
  login: { id: string; pgUser: string; status: string };
  connect: ConnectInfo;
};

export type DbAccess = {
  rows: DbAccessRow[];
  gateway: { host: string; port: number; hostKey: string | null; hostKeys?: string[] };
  minCliVersion?: string;
};

export type Session = {
  user: { id: string; email: string; name: string | null };
  workspaces: { id: string; name: string }[];
  session: { id: string; name: string; last4: string; createdAt: string; expiresAt: string };
  minCliVersion?: string;
};

export type SshKey = { id: string; name: string; fingerprint: string; source?: "user" | "cli"; expiresAt?: string | null };

export type DeviceStart = { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number };
export type DeviceToken = { token: string; expiresAt: string; user: { name: string | null; email: string } };

/** An answer of the API that wasn't 2xx. */
export class ApiError extends CliError {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

export const userAgent = (ctx: Pick<Context, "platform" | "arch">) => `beaver-cli/${VERSION} (${ctx.platform}-${ctx.arch})`;

export class Api {
  readonly base: string;
  constructor(
    private readonly ctx: Context,
    private readonly token: string | null,
  ) {
    this.base = apiUrl(ctx);
  }

  async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.ctx.fetch(`${this.base}${path}`, {
        method,
        headers: {
          accept: "application/json",
          "user-agent": userAgent(this.ctx),
          ...(body !== undefined && { "content-type": "application/json" }),
          ...(this.token && { authorization: `Bearer ${this.token}` }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : String(err);
      throw new CliError(`Couldn't reach ${new URL(this.base).host}: ${reason}. Check your connection, or run: beaver doctor`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (res.ok) return data as T;
    const code = data.error?.code ?? `http_${res.status}`;
    const message = data.error?.message ?? `Beaver Ops answered ${res.status}`;
    if (res.status === 401 && this.token) throw new NotSignedInError("Your CLI session ended (signed out, revoked or unused for 90 days). Run: beaver login");
    if (res.status === 401) throw new NotSignedInError();
    if (code === "cli_not_allowed") throw new ApiError(res.status, code, "This Beaver Ops refuses this CLI request. Run: beaver update");
    throw new ApiError(res.status, code, message);
  }

  /** The person's databases; 404 = Database access isn't on for any of their workspaces. */
  async dbAccess(): Promise<DbAccess> {
    const access = await this.request<DbAccess>("GET", "/api/me/db-access").catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) throw new CliError("None of your workspaces has Database access: there is nothing to open. Ask a workspace admin.");
      throw err;
    });
    assertVersion(access.minCliVersion);
    return access;
  }

  async session(): Promise<Session> {
    const s = await this.request<Session>("GET", "/api/cli/session");
    assertVersion(s.minCliVersion);
    return s;
  }
}

/** An older CLI than the server still serves says so instead of failing on a changed answer. */
export function assertVersion(min: string | undefined): void {
  if (min && compareVersions(VERSION, min) < 0) throw new CliError(`This CLI (${VERSION}) is too old: Beaver Ops needs ${min} or newer. Run: beaver update`);
}
