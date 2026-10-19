// Cloudflare entry point (the "receptionist").
// Stage S0: serves the probe report and wakes the Tracker every minute. Replaced by the full bot in S4.
import { Tracker } from './tracker.ts';

export { Tracker };

const VERSION = '2.0.0-probe';

function tracker(env: Env): DurableObjectStub<Tracker> {
  return env.TRACKER.get(env.TRACKER.idFromName('main'));
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/health') return Response.json({ ok: true, stage: 'probe', version: VERSION });
    if (url.pathname === '/probe') {
      return Response.json(await tracker(env).report(), { headers: { 'cache-control': 'no-store' } });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(tracker(env).tick(controller.scheduledTime));
  }
} satisfies ExportedHandler<Env>;
