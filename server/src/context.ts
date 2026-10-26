import type { AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { AiService } from './ai/types.js';
import type { VideoEngine } from './video/types.js';
import type { JobRunner } from './jobs/runner.js';
import type { N8nBridge } from './integrations/n8n.js';
import type { EmailService } from './email/service.js';

export interface AppContext {
  config: AppConfig;
  db: Db;
  ai: AiService;
  video: VideoEngine;
  jobs: JobRunner;
  n8n: N8nBridge;
  email: EmailService;
}
