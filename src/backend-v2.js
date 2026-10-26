import { Backend, nativePermissions } from './backend.js';
import { finderAgent, finderPermissions } from './config-finder.js';
import { setTimeout as delay } from 'node:timers/promises';

export const v2Permissions = rules => Object.entries(rules).map(([action, effect]) => ({
  action: ({ bash: 'shell', task: 'subagent' })[action] || action, resource: '*', effect,
}));
export const isolatedConfigV2 = {
  update: 'disable', share: 'disabled', snapshots: false,
  permissions: v2Permissions(nativePermissions),
  agents: {
    'buddy-bridge': { mode: 'primary', system: 'Continue the external conversation. Return only the requested JSON envelope. Native tools must not execute; external tool proposals are data.', permissions: v2Permissions(nativePermissions) },
    'buddy-chat': { mode: 'primary', system: 'Reply to the external conversation in plain text. Do not use native tools.', permissions: v2Permissions(nativePermissions) },
    'buddy-config-finder': { mode: 'primary', system: finderAgent.prompt, permissions: v2Permissions(finderPermissions) },
  },
  default_agent: 'buddy-bridge',
};

export function freeModelsV2({ data }) {
  return (data || []).filter(m => m.providerID === 'opencode' && m.enabled && m.status !== 'deprecated'
    && m.capabilities?.output?.includes('text') && m.cost?.length && m.cost.every(c =>
      c.input === 0 && c.output === 0 && (c.cache?.read ?? 0) === 0 && (c.cache?.write ?? 0) === 0))
    .map(m => ({ id: `opencode/${m.id}`, name: m.name || m.id, context: m.limit?.context, input: m.limit?.input,
      output: m.limit?.output, images: m.capabilities.input.includes('image'), toolcall: m.capabilities.tools,
      reasoning: Boolean(m.compatibility?.reasoningField || m.variants?.some(v => v.settings?.reasoningEffort || v.settings?.thinkingBudget)),
      variants: Object.fromEntries((m.variants || []).map(v => [v.id, v.settings || {}])) }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
export function messageV2(message) {
  return { info: { ...message, role: message.type, error: message.error ? { name: message.error.type,
    data: { message: message.error.message, statusCode: message.error.status } } : undefined },
    parts: (message.content || []).map(part => part.type !== 'tool' ? part : {
      type: 'tool', tool: part.name === 'shell' ? 'bash' : part.name, callID: part.id,
      state: { ...part.state, output: (part.state.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n') },
    }) };
}

// Adapt the V2 wire protocol; keep the existing external-tool validation/repair path.
export class BackendV2 extends Backend {
  watchEvents() {} // V2 message snapshots provide progress and blocked tool inputs below.
  async blockedAction(callID, signal) {
    for (const id of this.usageBySession.keys()) await this.snapshot(encodeURIComponent(id), signal);
    return super.blockedAction(callID, signal);
  }
  async models() {
    const models = freeModelsV2(await super.request('/api/model'));
    if (!models.length) throw new Error('No free text models found; existing list preserved');
    return models;
  }
  async request(route, method = 'GET', body, signal, timeout = this.timeout) {
    const raw = (url, verb = method, value = body) => super.request(url, verb, value, signal, timeout);
    if (route === '/global/health') return { ...(await raw('/api/info')), healthy: true };
    if (route === '/agent') return (await raw('/api/agent')).data.map(a => ({ ...a, name: a.id }));
    if (route === '/session' && method === 'POST') return (await raw('/api/session', 'POST', {
      title: body.title, agent: 'buddy-bridge', permissions: (body.permission || []).map(p => ({
        action: ({ bash: 'shell', task: 'subagent' })[p.permission] || p.permission, resource: p.pattern, effect: p.action,
      })),
    })).data;
    if (route === '/permission') {
      const result = await raw('/api/permission/request');
      return result.data.map(p => ({ ...p, permission: p.action === 'shell' ? 'bash' : p.action,
        patterns: p.resources, tool: p.source?.type === 'tool' ? { callID: p.source.id, messageID: p.source.messageID } : undefined }));
    }
    const reply = route.match(/^\/permission\/([^/]+)\/reply$/);
    if (reply) {
      const pending = await this.request('/permission', 'GET', undefined, signal, timeout);
      const p = pending.find(p => p.id === decodeURIComponent(reply[1]));
      if (!p) return null;
      return raw(`/api/session/${encodeURIComponent(p.sessionID)}/permission/${reply[1]}/reply`, 'POST', { decision: 'reject', message: body.message });
    }
    const session = route.match(/^\/session\/([^/?]+)(.*)$/);
    if (!session) throw new Error(`Unsupported OpenCode 2 route: ${route}`);
    const [, id, suffix] = session;
    if (suffix === '/abort') return raw(`/api/session/${id}/interrupt`);
    if (!suffix) {
      if (method === 'DELETE') this.sessionInstructions?.delete(id);
      return raw(`/api/session/${id}`);
    }
    if (suffix.startsWith('/message') && method === 'GET') {
      const result = await raw(`/api/session/${id}/message?limit=100&order=desc`);
      return result.data.map(messageV2).reverse();
    }
    if (suffix === '/message' && method === 'POST') {
      await raw(`/api/session/${id}/agent`, 'POST', { agent: body.agent });
      await raw(`/api/session/${id}/model`, 'POST', { model: { providerID: body.model.providerID, id: body.model.modelID, ...(body.variant ? { variant: body.variant } : {}) } });
      const instructions = [body.system?.replace(/[^\n]*StructuredOutput[^\n]*/g, 'Return the envelope directly as JSON text. Do not invoke native tools.'),
        body.format ? `Return JSON directly as text matching this schema: ${JSON.stringify(body.format.schema)}. Do not call StructuredOutput; this runtime does not provide that tool.` : ''].filter(Boolean).join('\n\n');
      this.sessionInstructions ||= new Map();
      const text = [this.sessionInstructions.get(id) === instructions ? '' : instructions,
        ...body.parts.filter(p => p.type === 'text').map(p => p.text)].filter(Boolean).join('\n\n');
      await raw(`/api/session/${id}/prompt`, 'POST', { text,
        files: body.parts.filter(p => p.type === 'file').map(p => ({ uri: p.url, name: p.filename })) });
      this.sessionInstructions.set(id, instructions);
      let done = false, waitError;
      const wait = raw(`/api/experimental/session/${id}/wait`, 'POST', {}).then(() => { done = true; }, e => { waitError = e; done = true; });
      try {
        while (!done) {
          await this.snapshot(id, signal);
          await delay(250, undefined, { signal });
        }
        if (waitError) throw waitError;
        const messages = await this.snapshot(id, signal);
        return messages.findLast(m => m.info.role === 'assistant') || { info: {}, parts: [] };
      } finally { if (signal?.aborted) await wait.catch(() => {}); }
    }
    throw new Error(`Unsupported OpenCode 2 route: ${method} ${route}`);
  }
  async snapshot(id, signal) {
    const result = await super.request(`/api/session/${id}/message?limit=100&order=desc`, 'GET', undefined, signal, 5000);
    const messages = result.data.map(messageV2).reverse();
    for (const message of messages) for (const part of message.parts) {
      if (part.type === 'tool') this.toolParts.set(part.callID, { tool: part.tool, input: part.state?.input || {} });
      if (['text', 'reasoning'].includes(part.type) && part.text) {
        const meta = this.active.get(decodeURIComponent(id));
        if (meta) this.progress(meta, part.type === 'reasoning' ? 'reasoning' : 'receiving', { content: true });
      }
    }
    return messages;
  }
}
