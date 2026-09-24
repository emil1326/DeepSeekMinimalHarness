/**
 * Whether a request came from this machine's own browser, or from a local
 * program. There is no token, no cookie and no login.
 *
 * **Why not.** This is not a website. It is one page showing one person his own
 * runs, on his own machine, and every one of those mechanisms was UX cost paid
 * against a threat it did not actually close. Measured on this machine: the
 * session cookie *was* the daemon token (`sessionCookie()` returned
 * `dsh_session=${token}`), so restarting to pick up a build logged every open tab
 * out; the login was a one-time ticket that expired in sixty seconds, so a second
 * browser needed its own `dsh ui`; and the token was written to `daemon.json` in
 * plain text, readable by any program running as this user — which is to say, by
 * every process the token could plausibly have been protecting against. A local
 * program that wants to drive the daemon can read `daemon.json`, and read the
 * DeepSeek key at `~/.deepseek/api_key` besides. A secret cannot defend a
 * resource from a caller that can read the secret.
 *
 * **What is left, and why it is not nothing.** A localhost server is reachable
 * from any page the browser happens to have open, so with no check at all a
 * random site could POST `/runs/run-1a2b/cancel` — a route that takes no body —
 * or start a run that spends money and writes into a worktree. That is a real
 * threat and it is the only one worth answering here, so it is answered with
 * three headers a browser sets and a page cannot forge:
 *
 *   - `Host` has to be this daemon. This is the one that stops DNS rebinding,
 *     where an attacker's domain is made to resolve to 127.0.0.1 so the browser
 *     then talks to the daemon believing it is talking to the attacker's server.
 *     It costs a person nothing: the only name he types is the one we serve on.
 *   - `Origin`, *when present*, has to be ours. Every cross-origin `fetch` and
 *     every form POST sends it, and `null` counts as foreign, because `null` is
 *     what a sandboxed iframe and a `file://` page send — the one value that
 *     means "a page, but not a page I can name" while looking like "no page".
 *   - `Sec-Fetch-Site`, when present, must not be `cross-site`. Browsers set this
 *     and forbid JavaScript from writing it, which makes it the single header an
 *     attacker's page cannot lie about. Checking `Origin` alone is not enough on
 *     its own, because a request with no `Origin` at all is allowed — all three
 *     together are what make that safe.
 *
 * A request with none of these — the CLI, `curl`, the Vite dev proxy — is
 * allowed through. Those are programs running as this user on this machine, and
 * a program that wants to drive the daemon is not a threat this can answer, for
 * the reason above.
 */
export interface RequestHeaders {
  host?: string | undefined;
  origin?: string | undefined;
  'sec-fetch-site'?: string | undefined;
}

export class Guard {
  private port: number;
  /** Lowercased once, because the headers are lowercased before they are compared. */
  private readonly uiHosts: string[];

  constructor(port: number, uiHosts: readonly string[] = []) {
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

  /**
   * Why this request must be refused, or null to let it through.
   *
   * A reason rather than a boolean so the 403 says which check failed. That is
   * for whoever is reading a log at midnight, not for an attacker: the response
   * names the host this daemon answers on, which is not a secret.
   */
  refuse(headers: RequestHeaders): string | null {
    const host = headers.host?.toLowerCase();
    if (host === undefined || !this.allowedHosts().includes(host)) {
      return `this daemon only answers ${this.allowedHosts().join(', ')}`;
    }

    const origin = headers.origin?.toLowerCase();
    if (origin !== undefined && origin !== '' && !this.allowedOrigins().includes(origin)) {
      return `${origin} is not this UI, and only this UI may drive the daemon`;
    }

    // `same-origin` is our own page, and `none` is a URL typed or bookmarked.
    // Anything else is a page somewhere else, which no browser will let a page
    // claim otherwise.
    const site = headers['sec-fetch-site']?.toLowerCase();
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      return `this request came from ${site}, and only this page may drive the daemon`;
    }

    return null;
  }
}
