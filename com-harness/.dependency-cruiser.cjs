module.exports = {
  forbidden: [
    {
      name: 'domain-only',
      severity: 'error',
      from: { path: '^src/domain/' },
      to: { pathNot: '^src/domain/' },
    },
    {
      name: 'application-dependencies',
      severity: 'error',
      from: { path: '^src/application/' },
      to: { pathNot: '^(src/(application|domain)/|node_modules/(rxjs|tslib)(/|$))' },
    },
    {
      name: 'http-dependencies',
      severity: 'error',
      from: { path: '^src/infra/' },
      to: { pathNot: '^(src/(infra|application|domain)/|node_modules/(express|@types/express)(/|$))' },
    },
    {
      name: 'resolved',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'acyclic',
      severity: 'error',
      from: { path: '^src/' },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
};
