module.exports = [{
  file: 'scripts/mock-upstream/server.ts',
  edits: [
    [`    const finish = (status: number) => record('google', words, kind, status, chars, keyInUrl, keyHeader);
`, `    // Counted on arrival: a request that is then dropped or left hanging never reaches finish().
    if (keyInUrl) stats.google.keyInUrl = (stats.google.keyInUrl ?? 0) + 1;
    if (keyHeader) stats.google.keyHeaderSeen = (stats.google.keyHeaderSeen ?? 0) + 1;
    const finish = (status: number) => record('google', words, kind, status, chars);
`],
  ],
}];
