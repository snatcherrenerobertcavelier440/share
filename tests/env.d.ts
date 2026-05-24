import type { Env as ShareEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends ShareEnv {}
  }
}

export {};
