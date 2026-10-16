import { lookupEnvSchema } from '../config/lookup';
const r = lookupEnvSchema.safeParse({});
console.log(r.success, r.success ? Object.keys(r.data).length : JSON.stringify(r.error.issues).slice(0,300));
if (r.success) console.log((r.data as any).ENRICHMENT_PUBLISH_POLICY);
