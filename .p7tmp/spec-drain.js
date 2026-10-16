module.exports = [
  {
    file: 'services/lookup/index.ts',
    edits: [[
      "export async function drainLookupBackground(maxMs: number = 10_000): Promise<void> {\n  if (!service) return;\n  let timer: NodeJS.Timeout | undefined;\n  await Promise.race([\n    service.idle(),\n    new Promise<void>((resolve) => {\n      timer = setTimeout(resolve, maxMs);\n    }),\n  ]);\n  if (timer) clearTimeout(timer);\n}",
      "export async function drainBackground(target: { idle(): Promise<void> } | undefined, maxMs: number = 10_000): Promise<void> {\n  if (!target) return;\n  let timer: NodeJS.Timeout | undefined;\n  await Promise.race([\n    target.idle().catch(() => undefined),\n    new Promise<void>((resolve) => {\n      timer = setTimeout(resolve, maxMs);\n    }),\n  ]);\n  if (timer) clearTimeout(timer);\n}\n\nexport const drainLookupBackground = (maxMs?: number): Promise<void> => drainBackground(service, maxMs);",
    ]],
  },
];
