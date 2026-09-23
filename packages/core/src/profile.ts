import { z } from 'zod';

/**
 * One entry in a profile: an argv, and the kinds of file it applies to.
 * `{allowed}` inside `run` expands to the allowed files matching `when`.
 */
export const checkSpecSchema = z
  .object({
    when: z.array(z.string().min(1)).optional(),
    run: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const profileSchema = z
  .object({
    description: z.string().optional(),
    env: z.record(z.string()).optional(),
    checks: z.record(checkSpecSchema).optional(),
    format: z.array(checkSpecSchema).optional(),
  })
  .strict();

export type CheckSpec = z.infer<typeof checkSpecSchema>;
export type Profile = z.infer<typeof profileSchema>;

export interface ProfileProblem {
  path: string;
  message: string;
  file: string | null;
}

export function profileProblems(error: z.ZodError, file: string | null): ProfileProblem[] {
  const problems: ProfileProblem[] = [];
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) problems.push({ path: key, message: 'unknown key', file });
      continue;
    }
    problems.push({ path: issue.path.join('.') || '(root)', message: issue.message, file });
  }
  return problems;
}
