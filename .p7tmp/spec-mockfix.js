module.exports = [
  {
    file: 'scripts/mock-upstream/server.ts',
    edits: [
      [
        `  function reset(keep?: 'control' | 'stats'): void {
    if (keep !== 'stats') {`,
        `  function reset(keep?: 'control' | 'stats'): void {
    if (keep !== 'control') {`,
      ],
      [
        `    if (keep !== 'control') stats = newStats();`,
        `    if (keep !== 'stats') stats = newStats();`,
      ],
    ],
  },
  {
    file: 'tests/e2e/mockServer.test.ts',
    edits: [
      [
        `    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'tests', 'scripts', '.git', 'docs', 'public', 'views'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\\.(ts|js)$/.test(entry.name) && /mock-upstream/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(path.resolve(__dirname, '../..'), full));
      }
    };
    walk(path.resolve(__dirname, '../..'));
    expect(offenders).toEqual([]);`,
        `    // everything that is compiled into dist/ (see "include" in tsconfig.json)
    const root = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\\.ts$/.test(entry.name) && /mock-upstream/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(root, full));
      }
    };
    for (const dir of ['config', 'controllers', 'helpers', 'middlewares', 'models', 'routes', 'services', 'utils', 'database', 'types']) if (fs.existsSync(path.join(root, dir))) walk(path.join(root, dir));
    for (const file of ['app.ts', 'worker.ts']) if (/mock-upstream/.test(fs.readFileSync(path.join(root, file), 'utf8'))) offenders.push(file);
    expect(offenders).toEqual([]);`,
      ],
    ],
  },
];
