module.exports = [{
  file: 'scripts/mock-upstream/server.ts',
  edits: [
    [`  | 'hang' // never answer; the socket stays open until the client gives up`, `  | 'hang' // never answer; the socket stays open until the client gives up
  | 'drop' // close the connection without any answer (a network error for the client)`],
    [`    if (behavior.mode === 'html') {
      const status = behavior.status ?? 404;`, `    if (behavior.mode === 'drop') {
      stats[provider].statuses.dropped = (stats[provider].statuses.dropped ?? 0) + 1;
      res.socket?.destroy();
      return true;
    }
    if (behavior.mode === 'html') {
      const status = behavior.status ?? 404;`],
  ],
}];
