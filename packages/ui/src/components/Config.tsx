import type { ResolvedRunConfig } from '../types';
import { Json } from './Json';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * What the run was told, as settings you can read down the page.
 *
 * The raw JSON is the only copy of the truth and has to stay reachable, but
 * making it the first thing on the tab meant a wall of escaped quotes before
 * you could answer the one question that matters here: which files could this
 * agent touch. So the settings come first, and the JSON is one click away.
 */
export function ConfigView({ config }: { config: ResolvedRunConfig }) {
  return (
    <div className="scroller">
      <div className="pane">
        <h2>the rules this run worked under</h2>
        <dl className="fields">
          <Row label="task" value={config.name} />
          <Row label="model" value={<span className="mono">{config.model}</span>} />
          <Row label="worktree" value={<span className="mono">{config.worktree}</span>} />
          <Row
            label="may change"
            value={
              config.allow.length === 0
                ? '(nothing)'
                : config.allow.map((file) => (
                    <span className="mono chip" key={file}>
                      {file}
                    </span>
                  ))
            }
          />
          <Row
            label="checks"
            value={
              config.checks.length === 0
                ? '(none)'
                : config.checks.map((name) => (
                    <span className="mono chip" key={name}>
                      {name}
                    </span>
                  ))
            }
          />
          <Row
            label="limits"
            value={
              <span className="mono">
                {config.limits.turns} turns · {Math.round(config.limits.wallSeconds / 60)} min ·{' '}
                {config.limits.outputTokens.toLocaleString()} output tokens
              </span>
            }
          />
          {config.sourcePath !== null && (
            <Row label="task file" value={<span className="mono">{config.sourcePath}</span>} />
          )}
        </dl>
      </div>

      <div className="pane">
        <h2>
          what it was asked <span className="where">the task, verbatim</span>
        </h2>
        <p className="prose-block">{config.task}</p>
      </div>

      <details className="pane">
        <summary>the task file, exactly as it was given</summary>
        <Json value={config.raw} />
      </details>

      <details className="pane">
        <summary>the profile it ran against</summary>
        <Json value={config.resolvedProfile} />
      </details>

      <p className="hint">
        the profile is trusted configuration, hashed at {config.profileHash.slice(0, 16)}… and checked before
        every run. changing any of this means a new run.
      </p>
    </div>
  );
}
