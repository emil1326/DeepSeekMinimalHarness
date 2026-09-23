import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'dsh_session';

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * A localhost server is reachable from any web page, so without these checks a
 * random site could drive agents. Every request needs the token, the `Host` has
 * to be this daemon, and any `Origin` has to be the UI's own.
 *
 * "This daemon" and "the UI's own" are the loopback address and `localhost`, plus
 * whatever names `config.json` added. That second part does not widen anything:
 * the port is still the one bound, and the socket is still on 127.0.0.1, so a name
 * only works here if it was already pointed at the loopback address.
 */
export class Auth {
  private readonly tickets = new Map<string, number>();
  private port: number;
  /** Lowercased once, because the header is lowercased before it is compared. */
  private readonly uiHosts: string[];

  constructor(
    port: number,
    private readonly token: string,
    uiHosts: readonly string[] = [],
    private readonly ticketTtlMs = 60_000,
  ) {
    this.port = port;
    this.uiHosts = uiHosts.map((host) => host.toLowerCase());
  }

  /** The port is only known once the socket is bound, and the checks need it. */
  setPort(port: number): void {
    this.port = port;
  }

  get boundPort(): number {
    return this.port;
  }

  allowedHosts(): string[] {
    return [
      `127.0.0.1:${this.port}`,
      `localhost:${this.port}`,
      ...this.uiHosts.map((host) => `${host}:${this.port}`),
    ];
  }

  allowedOrigins(): string[] {
    return [
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`,
      ...this.uiHosts.map((host) => `http://${host}:${this.port}`),
    ];
  }

  checkHost(header: string | undefined): boolean {
    if (header === undefined) return false;
    return this.allowedHosts().includes(header.toLowerCase());
  }

  checkOrigin(header: string | undefined): boolean {
    // No Origin at all is the CLI, curl, or a same-origin fetch that did not
    // send one. A present-but-foreign Origin is refused.
    if (header === undefined || header === '' || header === 'null') return true;
    return this.allowedOrigins().includes(header.toLowerCase());
  }

  checkBearer(header: string | undefined): boolean {
    if (header === undefined) return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1] === undefined) return false;
    return this.same(match[1], this.token);
  }

  checkCookie(header: string | undefined): boolean {
    if (header === undefined) return false;
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === SESSION_COOKIE) return this.same(rest.join('='), this.token);
    }
    return false;
  }

  sessionCookie(): string {
    return `${SESSION_COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/`;
  }

  /** A one-time ticket, so the token itself never appears in a URL or a log. */
  issueTicket(): string {
    this.sweep();
    const ticket = randomBytes(24).toString('hex');
    this.tickets.set(ticket, Date.now() + this.ticketTtlMs);
    return ticket;
  }

  redeemTicket(ticket: string | null): boolean {
    if (ticket === null) return false;
    this.sweep();
    const expires = this.tickets.get(ticket);
    if (expires === undefined || expires < Date.now()) return false;
    this.tickets.delete(ticket);
    return true;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ticket, expires] of this.tickets) {
      if (expires < now) this.tickets.delete(ticket);
    }
  }

  private same(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
