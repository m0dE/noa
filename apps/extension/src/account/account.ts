/**
 * The Noa account in the background: the Google sign-in, the
 * session token (chrome.storage.local), the cached profile, plan and credit,
 * the out-of-credit flag, API keys, and moving local tasks into the account
 * after the first sign-in. Plans and top-ups are bought on the dashboard
 * (see dashboard.ts), never from here.
 *
 * A session belongs to the server it was issued by: when the account server
 * URL setting changes, the extension is signed out of it. An earlier default
 * address of the same server (currentAccountApiBase) is not a change.
 */
import { currentAccountApiBase, errorMessage, type ExtensionSettings, type MeBillingResponse, type TranscribeResponse, type VoiceEnginesResponse } from "@noa/shared";
import { ApiClient } from "../api-client.js";
import type { StorageLike } from "../engine/kv.js";
import type { StoredLocalTask } from "../engine/local-task-rules.js";
import { ApiRequestError, NotSignedInError } from "../http-client.js";
import { callSafely } from "../listeners.js";
import type { AccountView } from "../ui-protocol.js";
import { AccountApi } from "./account-api.js";
import { dashboardUrl } from "./dashboard.js";
import { googleIdToken, SIGN_IN_NOT_SET_UP, SignInError } from "./google-auth.js";
import { accountTaskInput } from "./todo-source.js";
import { isPaidActive, todoAllowed, type ApiKeyInfo, type CreatedApiKey, type CreditInfo, type KeyRole, type Me, type PlanInfo } from "./types.js";

export const ACCOUNT_KEY = "account";
/** Profile and credit are refetched when older than this (or on demand). */
const INFO_MAX_AGE_MS = 60_000;
/** How much of a task's instructions names it in a migration error. */
const TASK_LABEL_CHARS = 40;

export interface StoredSession {
  token: string;
  user: { id: string; email: string; name: string | null; pictureUrl: string | null };
  expiresAt: string;
  /** The server that issued it. */
  apiBase: string;
}

export interface StoredAccount {
  session?: StoredSession;
  info?: {
    plan?: PlanInfo;
    credit?: CreditInfo;
    /** undefined: not known (the server has no billing route yet). */
    stripeConfigured?: boolean;
    fetchedAt: string;
    error?: string;
  };
  /** A hosted AI request was refused with 402 (cleared when credit is back). */
  outOfCredit?: { at: string };
  /** "Not now" on the offer to move local tasks into the account. */
  migrationDismissed?: boolean;
}

/** What the brain resolver needs to know about the account. */
export interface BrainAccount {
  signedIn: boolean;
  /** Signed in with usage credit left, or on an active paid plan. */
  hostedUsable: boolean;
  outOfCredit: boolean;
}

export interface MigrationResult {
  moved: number;
  failed: number;
  errors: string[];
}

export interface AccountLocalTasks {
  list(): Promise<Pick<StoredLocalTask, "id" | "status" | "instructions" | "account" | "notBefore" | "mediaIds" | "repeat" | "agentAuthored">[]>;
  getMedia(ids: string[]): Promise<{ id: string; name: string; blob: Blob }[]>;
  delete(id: string): Promise<boolean>;
}

export interface AccountServiceDeps {
  loadSettings(): Promise<ExtensionSettings>;
  /** Built-in Google OAuth client ID ("" = ask the account server's GET /v1/config). */
  clientId: string;
  identity?: { redirectUri(): string; launch(url: string): Promise<string | undefined> };
  localTasks: AccountLocalTasks;
  storage?: StorageLike;
  fetch?: typeof fetch;
  now?(): Date;
  /** The IANA time zone repeats run in (default: the browser's). */
  timeZone?(): string;
  onChange?(): void;
  log?(message: string): void;
}

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Active local tasks that can move to the account (running ones stay until they end). */
const movable = (t: { status: string }) => t.status === "pending" || t.status === "paused";

export class AccountService {
  private cache: StoredAccount | null = null;
  private loading: Promise<StoredAccount> | null = null;
  private refreshing: Promise<void> | null = null;
  /** The accountApiBase setting as last read (sessions of other servers do not count). */
  private apiBase = "";

  constructor(private readonly deps: AccountServiceDeps) {}

  /** Reads the stored account once; later calls return the cache. */
  async load(): Promise<StoredAccount> {
    if (this.cache) {
      this.apiBase = (await this.deps.loadSettings()).accountApiBase;
      return this.cache;
    }
    this.loading ??= (async () => {
      const [got, settings] = await Promise.all([this.storage().get(ACCOUNT_KEY), this.deps.loadSettings()]);
      this.apiBase = settings.accountApiBase;
      this.cache = await this.migrateSession((got[ACCOUNT_KEY] as StoredAccount | undefined) ?? {});
      return this.cache;
    })().finally(() => (this.loading = null));
    return this.loading;
  }

  /**
   * A session issued at an earlier default address of the account server is
   * kept at its current address (the same server answers at both), like the
   * setting (currentAccountApiBase), so the move does not sign anyone out.
   */
  private async migrateSession(stored: StoredAccount): Promise<StoredAccount> {
    const s = stored.session;
    if (!s || currentAccountApiBase(s.apiBase) === s.apiBase) return stored;
    const next = { ...stored, session: { ...s, apiBase: currentAccountApiBase(s.apiBase) } };
    await this.storage().set({ [ACCOUNT_KEY]: next });
    return next;
  }

  /** The usable session (right server, not expired), from the cache. */
  session(): StoredSession | null {
    const s = this.cache?.session;
    if (!s || !this.apiBase || s.apiBase !== this.apiBase) return null;
    if (Date.parse(s.expiresAt) <= this.now().getTime()) return null;
    return s;
  }

  /** Synchronous view for the brain resolver (call load() first). */
  brainAccount(): BrainAccount {
    const s = this.session();
    if (!s) return { signedIn: false, hostedUsable: false, outOfCredit: false };
    const info = this.cache?.info;
    const credit = info?.credit?.totalCents ?? 0;
    const outOfCredit = !!this.cache?.outOfCredit;
    const hostedUsable = (credit > 0 && !outOfCredit) || isPaidActive(info?.plan);
    return { signedIn: true, hostedUsable, outOfCredit: outOfCredit || (!!info?.credit && credit <= 0) };
  }

  /**
   * The signed-in account's plan (as last fetched) includes the TODO list.
   * Without it nothing of the account's list is fetched for running or
   * scheduled, and local tasks are not offered a move into it.
   */
  todoAllowed(): boolean {
    return !!this.session() && todoAllowed(this.cache?.info?.plan);
  }

  /** The account as the UI shows it. */
  async view(): Promise<AccountView> {
    const a = await this.load();
    const base = this.apiBase;
    // Without a built-in client ID the account server names one at sign-in (and says so when it has none).
    const view: AccountView = {
      signedIn: false,
      signInConfigured: !!this.deps.clientId || !!base,
      apiBase: base,
      dashboardUrl: dashboardUrl(base),
      billingUrl: dashboardUrl(base, "billing"),
    };
    const s = this.session();
    if (!s) return view;
    view.signedIn = true;
    view.user = { email: s.user.email, name: s.user.name, pictureUrl: s.user.pictureUrl };
    if (a.info?.plan) view.plan = a.info.plan;
    if (a.info?.credit) view.credit = a.info.credit;
    if (a.info?.stripeConfigured !== undefined) view.stripeConfigured = a.info.stripeConfigured;
    if (a.info?.error) view.error = a.info.error;
    if (a.info?.fetchedAt) view.fetchedAt = a.info.fetchedAt;
    const brain = this.brainAccount();
    if (brain.outOfCredit) view.outOfCredit = true;
    if (!a.migrationDismissed && this.todoAllowed()) {
      try {
        const n = (await this.deps.localTasks.list()).filter(movable).length;
        if (n) view.localTasks = n;
      } catch {
        /* the offer just does not show */
      }
    }
    return view;
  }

  /** The signed-in account's API client. Throws when signed out. */
  async api(): Promise<AccountApi> {
    await this.load();
    const s = this.session();
    if (!s) throw new NotSignedInError();
    return this.apiFor(s);
  }

  /** Voice input: a WAV clip to text (POST /v1/ai/transcribe). Throws NotSignedInError or ApiRequestError. */
  async transcribe(wav: Uint8Array, opts: { speechMs?: number; context?: string; sessionId?: string } = {}): Promise<TranscribeResponse> {
    return (await this.api()).transcribe(wav, opts);
  }

  /** Hands-free voice: the engines and their prices (public; the account server's answer). */
  async voiceEngines(): Promise<VoiceEnginesResponse> {
    await this.load();
    return new AccountApi(this.apiOpts(this.apiBase)).voiceEngines();
  }

  /** Realtime voice: the session's server and token, which the side panel offers the relay. Throws NotSignedInError. */
  async realtimeSession(): Promise<{ apiBase: string; token: string }> {
    await this.load();
    const s = this.session();
    if (!s) throw new NotSignedInError();
    return { apiBase: s.apiBase, token: s.token };
  }

  /**
   * The runner's task source for the signed-in account (claim/heartbeat/result
   * with the session token), or null: signed out, or the plan does not include
   * the TODO list (the plan is refetched at most once a minute, so a new
   * subscription is picked up).
   */
  async runnerApi(): Promise<ApiClient | null> {
    await this.refresh().catch(() => undefined);
    const s = this.session();
    if (!s || !this.todoAllowed()) return null;
    return new ApiClient({ ...this.apiOpts(s.apiBase), token: s.token, onUnauthorized: () => void this.expire(s.token) });
  }

  /** A sign-in in progress: a second click waits for it instead of opening another Google window (Chrome allows one). */
  private signingIn: Promise<void> | null = null;

  signIn(): Promise<void> {
    this.signingIn ??= this.runSignIn().finally(() => (this.signingIn = null));
    return this.signingIn;
  }

  private async runSignIn(): Promise<void> {
    const settings = await this.deps.loadSettings();
    if (!this.deps.clientId && !settings.accountApiBase) throw new SignInError(SIGN_IN_NOT_SET_UP);
    if (!settings.accountApiBase) throw new SignInError("Set the account server URL first (Settings > Advanced)");
    const identity = this.deps.identity;
    if (!identity) throw new SignInError("Sign-in is not available in this browser");
    const api = new AccountApi(this.apiOpts(settings.accountApiBase));
    const clientId = this.deps.clientId || (await this.serverClientId(api));
    const idToken = await googleIdToken({ clientId, redirectUri: identity.redirectUri(), launch: (url) => identity.launch(url) });
    let auth;
    try {
      auth = await api.signIn(idToken);
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 503) throw new SignInError(`${err.message} (${settings.accountApiBase})`);
      throw err;
    }
    await this.load();
    this.apiBase = settings.accountApiBase;
    await this.store({
      session: { token: auth.token, user: auth.user, expiresAt: auth.expiresAt, apiBase: settings.accountApiBase },
    });
    await this.refresh(true);
  }

  /** The account server's Google client ID, for builds without one built in. */
  private async serverClientId(api: AccountApi): Promise<string> {
    let id: string;
    try {
      id = await api.googleClientId();
    } catch (err) {
      throw new SignInError(`Could not reach the account server (${api.base}): ${errorMessage(err)}`);
    }
    if (!id) throw new SignInError(`Google sign-in is not set up on the account server (${api.base})`);
    return id;
  }

  async signOut(): Promise<void> {
    await this.load();
    const s = this.cache?.session;
    if (s) {
      try {
        await this.apiFor(s).logout();
      } catch (err) {
        this.log(`logout: ${errorMessage(err)}`);
      }
    }
    await this.store({});
  }

  /** Refetches profile, plan, credit and billing (at most once a minute unless forced). */
  async refresh(force = false): Promise<void> {
    await this.load();
    const s = this.session();
    if (!s) return;
    const age = this.now().getTime() - Date.parse(this.cache?.info?.fetchedAt ?? "");
    if (!force && age < INFO_MAX_AGE_MS) return;
    this.refreshing ??= this.doRefresh(s).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(s: StoredSession): Promise<void> {
    const api = this.apiFor(s);
    const fetchedAt = this.now().toISOString();
    let me: Me;
    try {
      me = await api.me();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 401) return; // expire() signed us out
      await this.store({ ...this.cache, info: { ...this.cache?.info, fetchedAt, error: `Could not load the account: ${errorMessage(err)}` } });
      return;
    }
    let billing: MeBillingResponse | null = null;
    let stripeConfigured: boolean | undefined;
    try {
      billing = await api.billing();
      stripeConfigured = billing.stripeConfigured;
    } catch (err) {
      // No billing on this server (older API, or Stripe not configured).
      if (err instanceof ApiRequestError && (err.status === 404 || err.status === 503)) stripeConfigured = false;
      else this.log(`billing: ${errorMessage(err)}`);
    }
    const plan = billing?.plan ?? me.plan;
    const credit = billing?.credit ?? me.credit;
    const info: NonNullable<StoredAccount["info"]> = { fetchedAt };
    if (plan) info.plan = plan;
    if (credit) info.credit = credit;
    if (stripeConfigured !== undefined) info.stripeConfigured = stripeConfigured;
    const next: StoredAccount = {
      ...this.cache,
      session: { ...s, user: { id: me.id, email: me.email, name: me.name, pictureUrl: me.pictureUrl } },
      info,
    };
    if (credit && credit.totalCents > 0) delete next.outOfCredit;
    await this.store(next);
  }

  /** A hosted request answered 402: show "Out of usage credit" until the credit is back. */
  async markOutOfCredit(): Promise<void> {
    await this.load();
    if (!this.session()) return;
    const info = this.cache?.info;
    const next: StoredAccount = { ...this.cache, outOfCredit: { at: this.now().toISOString() } };
    if (info?.credit) next.info = { ...info, credit: { ...info.credit, totalCents: Math.min(0, info.credit.totalCents) } };
    await this.store(next);
  }

  async listKeys(): Promise<ApiKeyInfo[]> {
    return (await this.api()).listKeys();
  }

  async createKey(name: string, role: KeyRole): Promise<CreatedApiKey> {
    return (await this.api()).createKey(name, role);
  }

  async revokeKey(id: string): Promise<void> {
    await (await this.api()).revokeKey(id);
  }

  /** "Not now" on moving local tasks. Asked again after the next sign-in. */
  async dismissMigration(): Promise<void> {
    await this.load();
    await this.store({ ...this.cache, migrationDismissed: true });
  }

  /**
   * Moves the pending and paused local tasks (with their files) into the
   * account. Each task that made it is deleted locally; the others stay.
   */
  async migrateLocalTasks(): Promise<MigrationResult> {
    const api = await this.api();
    const tz = this.deps.timeZone?.() ?? browserTimeZone();
    const tasks = (await this.deps.localTasks.list()).filter(movable);
    const result: MigrationResult = { moved: 0, failed: 0, errors: [] };
    for (const t of tasks) {
      try {
        const files = await this.deps.localTasks.getMedia(t.mediaIds);
        await api.createTask(await accountTaskInput(api, t, files, tz));
        await this.deps.localTasks.delete(t.id);
        result.moved++;
      } catch (err) {
        result.failed++;
        result.errors.push(`${t.instructions.slice(0, TASK_LABEL_CHARS)}: ${errorMessage(err)}`);
      }
    }
    if (result.failed === 0) await this.store({ ...this.cache, migrationDismissed: true });
    else this.changed();
    return result;
  }

  private apiFor(s: StoredSession): AccountApi {
    return new AccountApi({ ...this.apiOpts(s.apiBase), token: s.token, onUnauthorized: () => void this.expire(s.token) });
  }

  private apiOpts(apiBase: string): { apiBase: string; fetch?: typeof fetch } {
    return this.deps.fetch ? { apiBase, fetch: this.deps.fetch } : { apiBase };
  }

  /** The server no longer accepts this session: signed out. */
  private async expire(token: string): Promise<void> {
    await this.load();
    if (this.cache?.session?.token !== token) return;
    this.log("the account session expired; signed out");
    await this.store({});
  }

  private async store(next: StoredAccount): Promise<void> {
    this.cache = next;
    await this.storage().set({ [ACCOUNT_KEY]: next });
    this.changed();
  }

  private changed(): void {
    callSafely(this.deps.onChange);
  }

  private storage(): StorageLike {
    return this.deps.storage ?? chrome.storage.local;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private log(m: string): void {
    this.deps.log?.(m);
  }
}
