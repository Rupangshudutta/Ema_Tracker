// Cloudflare entry point (the "receptionist"): passes every web request to the Tracker Durable Object and pokes it
// every minute so its alarm can never be lost. All logic lives in the Tracker's engine.
import { Tracker } from './tracker.ts';

export { Tracker };

// `wrangler types` only types this binding when its own pre-build check passes, so declare it here explicitly.
type WorkerEnv = Omit<Env, 'TRACKER'> & { TRACKER: DurableObjectNamespace<Tracker> };

function tracker(env: WorkerEnv): DurableObjectStub<Tracker> {
  return env.TRACKER.get(env.TRACKER.idFromName('main'));
}

export default {
  async fetch(request, env): Promise<Response> {
    return tracker(env).fetch(request);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(tracker(env).tick());
  }
} satisfies ExportedHandler<WorkerEnv>;
