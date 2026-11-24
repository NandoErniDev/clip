/** Worker bindings and Hono context types. */

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
}

export interface WorkerVariables {
  clipboardId: string;
}

export type AppEnv = { Bindings: Env; Variables: WorkerVariables };
