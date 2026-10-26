import { generateAnalysisFootage } from '../scripts/make-test-footage.ts';
const f = await generateAnalysisFootage(process.env.TEMP + '/anfoot', { reuse: true });
console.log(f);
