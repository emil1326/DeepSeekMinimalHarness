import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { money, statusWord, tokens } from '../format';

/**
 * What happened, for whoever commissioned the run.
 *
 * The reason this is a panel and not a paragraph: seven of nine real runs died
 * at a limit and the only way to find that out was to read the event log by
 * hand. `stopped_at_limit` sat in a status column next to `finished`, and the
 * most prominent thing on the page was the agent's own cheerful closing
 * paragraph — which, when a check it ran last had failed, was simply wrong.
 *
 * Everything here is derived rather than asserted. "Finished" means the agent
 * called `finish`; whether the checks agreed is a separate line.
 */
/**
 * Twice a dollar budget, rounded to a millionth.
 *
 * Adding cents to a float is how a budget ends up stored as 0.15000000000000002
 * and shown that way on the next screen.
 */
function doubleCost(value: number | undefined): number {
  return Math.round((value ?? 0) * 2 * 1e6) / 1e6;
}

export function Report({ runId, live, taskPath }: { runId: string; live: boolean; taskPath: string | null }) {
  const queryClient = useQueryClient();
  const report = useQuery({
    queryKey: ['report', runId],
    queryFn: () => api.report(runId),
    refetchInterval: live ? 5000 : false,
  });

  const grant = useMutation({
    mutationFn: (patch: Record<string, number>) => api.setLimits(runId, patch),
    onSuccess: () => void queryClient.invalidateQueries(),
  });
  const again = useMutation({
    mutationFn: (limits: Record<string, number>) => {
      if (taskPath === null) throw new Error('this run does not record the task file it came from');
      return api.continueRun(runId, taskPath, limits);
    },
    onSuccess: () => void queryClient.invalidateQueries(),
  });

  if (report.isPending) return <div className="empty">reading the run…</div>;
  if (report.isError) return <div className="empty">{(report.error as Error).message}</div>;
  const data = report.data;

  const tone = data.status === 'finished' && data.claimSupported !== false ? 'good' : 'bad';

  return (
    <div className="scroller">
      <div className="report">
        <p className="report-headline" data-tone={tone}>
          {data.headline}
        </p>

        <dl className="report-facts">
          <div>
            <dt>status</dt>
            <dd>{statusWord(data.status)}</dd>
          </div>
          <div>
            <dt>turns</dt>
            <dd>{data.turns}</dd>
          </div>
          <div>
            <dt>model</dt>
            <dd>{data.model}</dd>
          </div>
          <div>
            <dt>billed</dt>
            <dd>
              {tokens(data.totals.billedTokens)} of {tokens(data.limits.totalTokens)}
            </dd>
          </div>
          <div>
            <dt>prompt sent</dt>
            <dd>
              {tokens(data.totals.promptTokens)}
              <span className="quiet"> ({tokens(data.totals.cacheHitTokens)} cached)</span>
            </dd>
          </div>
          {data.totals.costUsd !== null && (
            <div>
              <dt>cost</dt>
              <dd>
                {money(data.totals.costUsd)}
                <span className="quiet"> of {money(data.limits.costUsd)}</span>
              </dd>
            </div>
          )}
        </dl>

        <h3>checks</h3>
        {data.checks.length === 0 ? (
          <p className="quiet">None were run, so nothing verified this change.</p>
        ) : (
          <ul className="report-checks">
            {data.checks.map((check) => (
              <li key={check.name} data-outcome={check.outcome}>
                <span className="word">
                  {check.outcome === 'pass' ? 'pass' : check.outcome === 'fail' ? 'FAIL' : 'n/a'}
                </span>
                <span className="name">{check.name}</span>
                <span className="quiet">{check.output.split('\n').slice(0, 2).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}

        <h3>files</h3>
        <p>
          {data.changed.length === 0 ? (
            <span className="quiet">nothing changed</span>
          ) : (
            <span>{data.changed.join(', ')}</span>
          )}
        </p>
        {data.strayFailure !== null ? (
          <p className="report-loud">
            Could not check for changes outside the allowed files: {data.strayFailure}
          </p>
        ) : (
          data.stray.length > 0 && (
            <p className="report-loud">Changed outside the allowed files: {data.stray.join(', ')}</p>
          )
        )}

        {data.questions.length > 0 && (
          <>
            <h3>questions</h3>
            <ul className="report-questions">
              {data.questions.map((question) => (
                <li key={question.question}>
                  <span>{question.question}</span>
                  <span className={question.answer === null ? 'unanswered' : 'quiet'}>
                    {question.answer ?? 'never answered'}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        {data.claim !== null && (
          <>
            <h3>the agent's own claim</h3>
            {data.claimSupported === false && (
              <p className="report-loud">Not backed by a check: one it ran last did not pass.</p>
            )}
            <pre className="report-claim">{data.claim}</pre>
          </>
        )}

        {data.warnings > 0 && (
          <p className="quiet">
            The harness warned this run {data.warnings} time{data.warnings === 1 ? '' : 's'} before it
            stopped, about {data.warnedAbout.join(' and ')}.
          </p>
        )}

        {data.status === 'stopped_at_limit' && (
          <div className="report-next">
            <p>
              This run did not finish. Its changes are in the worktree, partially applied. Continuing it
              replays the conversation exactly, so the prompt cache still hits and the agent does not re-read
              what it already knows.
            </p>
            {live ? (
              <>
                <button
                  onClick={() =>
                    grant.mutate({
                      turns: data.limits.turns + 20,
                      // The dollar budget as well, or a run that stopped on
                      // money would be granted turns it cannot afford to use.
                      costUsd: doubleCost(data.limits.costUsd),
                    })
                  }
                  disabled={grant.isPending}
                  title="It is still going, so this raises the budget it is working to right now."
                >
                  grant 20 more turns
                </button>
                {grant.isError && <span className="quiet">{(grant.error as Error).message}</span>}
              </>
            ) : (
              <>
                <button
                  onClick={() =>
                    again.mutate({ turns: data.limits.turns * 2, costUsd: doubleCost(data.limits.costUsd) })
                  }
                  disabled={again.isPending || taskPath === null}
                  title={
                    taskPath === null
                      ? 'This run does not record the task file it came from'
                      : `Continue with ${data.limits.turns * 2} turns and ${money(doubleCost(data.limits.costUsd))} instead of ${data.limits.turns} and ${money(data.limits.costUsd)}`
                  }
                >
                  continue with double the room
                </button>
                {again.isError && <span className="quiet">{(again.error as Error).message}</span>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
