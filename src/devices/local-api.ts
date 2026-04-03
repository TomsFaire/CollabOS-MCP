import { Agent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";

const TOKEN_REFRESH_MS = 14 * 60 * 1000;

export type ApiResponse<T> = { code: number; message?: string; result?: T };

type TokenCache = { token: string; obtainedAt: number };

export class CollabOsClient {
  private tokens = new Map<string, TokenCache>();
  private dispatcher: Dispatcher | undefined;

  constructor(
    private readonly username: string,
    private readonly password: string,
    tlsInsecure: boolean,
  ) {
    if (tlsInsecure) {
      this.dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    }
  }

  private baseUrl(ip: string): string {
    const host = ip.includes(":") ? `[${ip}]` : ip;
    return `https://${host}`;
  }

  private async fetchJson<T>(
    ip: string,
    path: string,
    init: {
      method?: string;
      body?: string;
      timeoutMs?: number;
      headers?: Record<string, string>;
    },
  ): Promise<ApiResponse<T>> {
    const { timeoutMs = 30_000, method = "GET", body: reqBody, headers: hdr = {} } = init;
    const url = `${this.baseUrl(ip)}${path}`;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await undiciFetch(url, {
        method,
        body: method === "POST" ? reqBody : undefined,
        signal: ac.signal,
        dispatcher: this.dispatcher,
        headers: {
          "Content-Type": "application/json",
          "accept-language": "en-US,en",
          ...hdr,
        },
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(`Invalid JSON from ${path}: ${text.slice(0, 200)}`);
      }
      return parsed as ApiResponse<T>;
    } finally {
      clearTimeout(t);
    }
  }

  async signIn(ip: string): Promise<string> {
    const body = await this.fetchJson<{ auth_token: string }>(ip, "/api/v1/signin", {
      method: "POST",
      body: JSON.stringify({ username: this.username, password: this.password }),
    });
    if (body.code !== 200 || !body.result?.auth_token) {
      throw new Error(body.message || `Sign-in failed (${body.code})`);
    }
    return body.result.auth_token;
  }

  async getToken(ip: string): Promise<string> {
    const now = Date.now();
    const cached = this.tokens.get(ip);
    if (cached && now - cached.obtainedAt < TOKEN_REFRESH_MS) {
      return cached.token;
    }
    const token = await this.signIn(ip);
    this.tokens.set(ip, { token, obtainedAt: now });
    return token;
  }

  invalidateToken(ip: string): void {
    this.tokens.delete(ip);
  }

  async authorizedGet<T>(ip: string, path: string, timeoutMs: number): Promise<ApiResponse<T>> {
    const tryOnce = async () => {
      const token = await this.getToken(ip);
      return this.fetchJson<T>(ip, path, {
        method: "GET",
        timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      });
    };
    let r = await tryOnce();
    if (r.code === 401) {
      this.invalidateToken(ip);
      r = await tryOnce();
    }
    return r;
  }

  getDevice(ip: string, timeoutMs: number) {
    return this.authorizedGet<Record<string, unknown>>(ip, "/api/v1/device", timeoutMs);
  }

  getPeripherals(ip: string, timeoutMs: number) {
    return this.authorizedGet<Record<string, unknown>>(ip, "/api/v1/peripherals", timeoutMs);
  }

  getInsightsRoom(ip: string, timeoutMs: number) {
    return this.authorizedGet<{
      occupancyCount?: number;
      occupancyMode?: string;
      environmentalData?: {
        co2?: number;
        temp?: number;
        relativeHumidity?: number;
        tvoc?: number;
        pm25?: number;
        pm10?: number;
        pressure?: number;
        presence?: string;
      };
    }>(ip, "/api/v1/insights/room", timeoutMs);
  }

  getInsightsDevice(ip: string, timeoutMs: number) {
    return this.authorizedGet<{
      deviceState?: string;
      micState?: string;
      speakerState?: string;
      speakerVolume?: number;
      speakerMaxVolume?: number;
    }>(ip, "/api/v1/insights/device", timeoutMs);
  }
}

export type PollSnapshot = {
  device: Record<string, unknown> | null;
  peripherals: Record<string, unknown> | null;
  room: unknown;
  deviceInsights: Record<string, unknown> | null;
  errors: string[];
};

export async function pollDeviceFull(
  client: CollabOsClient,
  ip: string,
  timeoutMs: number,
): Promise<{ ok: true; snapshot: PollSnapshot } | { ok: false; snapshot: PollSnapshot; error: string }> {
  const errors: string[] = [];
  let device: Record<string, unknown> | null = null;
  let peripherals: Record<string, unknown> | null = null;
  let room: PollSnapshot["room"] = null;
  let deviceInsights: Record<string, unknown> | null = null;

  const run = async <T>(
    label: string,
    fn: () => Promise<ApiResponse<T>>,
  ): Promise<T | null> => {
    try {
      const r = await fn();
      if (r.code !== 200) {
        errors.push(`${label}: HTTP ${r.code} ${r.message ?? ""}`);
        return null;
      }
      return (r.result ?? null) as T | null;
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  device = await run("device", () => client.getDevice(ip, timeoutMs));
  peripherals = await run("peripherals", () => client.getPeripherals(ip, timeoutMs));
  room = await run("insights/room", () => client.getInsightsRoom(ip, timeoutMs));
  deviceInsights = await run("insights/device", () => client.getInsightsDevice(ip, timeoutMs));

  const snapshot: PollSnapshot = {
    device,
    peripherals,
    room,
    deviceInsights,
    errors,
  };

  if (!device && errors.length > 0) {
    return { ok: false, snapshot, error: errors.join("; ") };
  }

  return { ok: true, snapshot };
}
