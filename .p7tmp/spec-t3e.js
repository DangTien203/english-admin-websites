module.exports = [
  { file: 'scripts/acceptance/lookup-acceptance.ts', edits: [[ "endProbe ? endProbe.result.healthy : null", "endProbe ? endProbe.healthy : null" ]] },
];
