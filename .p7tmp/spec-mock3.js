module.exports = [{
  file: 'scripts/mock-upstream/server.ts',
  edits: [
    [`  /** The first N matching requests fail with errorStatus, then the normal behaviour resumes. */
  failFirst?: number;`, `  /** The first N matching requests fail with errorStatus, then the normal behaviour resumes. */
  failFirst?: number;
  /** google only: the error message repeats the API key the request carried (what a careless provider could do). */
  echoKey?: boolean;`],
    [`    res: http.ServerResponse,
    done: (status: number) => void
  ): Promise<boolean> {`, `    res: http.ServerResponse,
    done: (status: number) => void,
    echo?: string
  ): Promise<boolean> {`],
    [`          : JSON.stringify({ error: { code: failWith, message: \`mock upstream error \${failWith}\`, status: 'MOCK_ERROR' } });`,
     `          : JSON.stringify({ error: { code: failWith, message: echo && behavior.echoKey ? \`API key not valid: \${echo}\` : \`mock upstream error \${failWith}\`, status: 'MOCK_ERROR' } });`],
    [`    if (await applyBehavior('google', behavior, key, res, finish)) return;`, `    const echoed = typeof req.headers['x-goog-api-key'] === 'string' ? (req.headers['x-goog-api-key'] as string) : undefined;
    if (await applyBehavior('google', behavior, key, res, finish, echoed)) return;`],
  ],
}];
