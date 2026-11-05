// Alert channels. Each one is { name, enabled(env), send(env, msg, fetchImpl) }
// where msg = { title, body, url }. Add a channel by adding an entry here.

export const CHANNELS = [
  {
    name: 'push',
    label: 'iPhone push (ntfy)',
    enabled: (env) => !!env.NTFY_TOPIC,
    async send(env, msg, fetchImpl = fetch) {
      const server = (env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
      const headers = { Title: asciiHeader(msg.title), Tags: 'fork_and_knife' };
      if (msg.url) headers.Click = msg.url;
      if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
      const res = await fetchImpl(`${server}/${encodeURIComponent(env.NTFY_TOPIC)}`, { method: 'POST', headers, body: msg.body });
      if (!res.ok) throw new Error(`ntfy ${res.status}`);
    },
  },
  {
    name: 'email',
    label: 'Email (Resend)',
    enabled: (env) => !!(env.RESEND_API_KEY && env.ALERT_EMAIL_TO && env.ALERT_EMAIL_FROM),
    async send(env, msg, fetchImpl = fetch) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: env.ALERT_EMAIL_FROM, to: [env.ALERT_EMAIL_TO], subject: msg.title,
          text: msg.url ? `${msg.body}\n\n${msg.url}` : msg.body,
        }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}`);
    },
  },
  {
    name: 'webhook',
    label: 'Webhook',
    enabled: (env) => !!env.ALERT_WEBHOOK_URL,
    async send(env, msg, fetchImpl = fetch) {
      const res = await fetchImpl(env.ALERT_WEBHOOK_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg),
      });
      if (!res.ok) throw new Error(`Webhook ${res.status}`);
    },
  },
];

function asciiHeader(s) {
  return String(s).replace(/[–—]/g, '-').replace(/[^\x20-\x7E]/g, '');
}

export function enabledChannels(env) {
  return CHANNELS.filter((c) => c.enabled(env));
}

/** Send to every enabled channel; returns [{ channel, ok, error? }]. */
export async function notify(env, msg, fetchImpl = fetch) {
  const results = [];
  for (const c of enabledChannels(env)) {
    try { await c.send(env, msg, fetchImpl); results.push({ channel: c.name, ok: true }); }
    catch (e) { results.push({ channel: c.name, ok: false, error: e.message }); }
  }
  return results;
}
