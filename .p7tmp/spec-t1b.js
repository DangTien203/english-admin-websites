module.exports = [
  {
    file: 'scripts/check-env-example.ts',
    edits: [
      [
        ` *   - the example values do not load: loadLookupConfig() rejects them (wrong type, out of range, a key missing for a feature that is on).
 *`,
        ` *   - the example values do not load: loadLookupConfig() rejects them (wrong type, out of range, a key missing for a feature that is on),
 *   - an example value is not the default of the schema. Copying .env.example to .env must behave like setting nothing; the day a default
 *     changes (ENRICHMENT_PUBLISH_POLICY went from auto to review, spec 1.5) the example has to be changed with it.
 *`,
      ],
      [
        `  /** problems from loadLookupConfig (names and messages, no values) */
  invalid: string[];`,
        `  /** problems from loadLookupConfig (names and messages, no values) */
  invalid: string[];
  /** schema variables whose example value is not the schema default (names only) */
  notDefault: string[];`,
      ],
      [
        `export function checkEnvExample(text: string, schemaKeys: readonly string[], load: (env: Record<string, string>) => unknown = loadLookupConfig as any): EnvExampleReport {`,
        `/** Parses variables the way the schema does, so that defaults and example values can be compared one by one. */
type ParseEnv = (env: Record<string, string>) => Record<string, unknown>;

export function checkEnvExample(
  text: string,
  schemaKeys: readonly string[],
  load: (env: Record<string, string>) => unknown = loadLookupConfig as any,
  parse: ParseEnv = (env) => lookupEnvSchema.parse(env) as Record<string, unknown>
): EnvExampleReport {`,
      ],
      [
        `  const ok = !parsed.markerMissing && missing.length === 0 && extra.length === 0 && duplicates.length === 0 && misplaced.length === 0 && invalid.length === 0;
  return { ok, missing, extra, duplicates, misplaced, invalid, markerMissing: parsed.markerMissing };`,
        `  // Is every example value the default? (Compared after parsing, so "" / "5" / "true" equal the typed default. Values the schema rejects were
  // reported above; they are not reported twice.)
  let notDefault: string[] = [];
  if (invalid.length === 0) {
    try {
      const defaults = parse({});
      const example = parse(env);
      notDefault = [...schemaKeys].filter((k) => JSON.stringify(example[k]) !== JSON.stringify(defaults[k])).sort();
    } catch {
      /* the schema cannot parse one of the two: already visible as "invalid" */
    }
  }

  const ok =
    !parsed.markerMissing && missing.length === 0 && extra.length === 0 && duplicates.length === 0 && misplaced.length === 0 && invalid.length === 0 && notDefault.length === 0;
  return { ok, missing, extra, duplicates, misplaced, invalid, notDefault, markerMissing: parsed.markerMissing };`,
      ],
      [
        `  for (const i of r.invalid) lines.push(\`  - giá trị ví dụ không hợp lệ: \${i}\`);
  return lines;`,
        `  for (const i of r.invalid) lines.push(\`  - giá trị ví dụ không hợp lệ: \${i}\`);
  for (const k of r.notDefault) lines.push(\`  - \${k}: giá trị trong .env.example khác mặc định của schema (chép .env.example thành .env phải cho cùng hành vi với không đặt gì)\`);
  return lines;`,
      ],
    ],
  },
];
