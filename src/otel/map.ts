import { z } from 'zod';

// OTLP/HTTP JSON, spans only, and only the handful of attributes that carry
// accounting meaning. Everything else is ignored rather than rejected: exporters
// send far more than we need and a strict schema would break on every SDK bump.

const AttrValue = z.object({
  stringValue: z.string().optional(),
  intValue: z.union([z.string(), z.number()]).optional(),
  doubleValue: z.number().optional(),
  boolValue: z.boolean().optional(),
});

const Attribute = z.object({
  key: z.string(),
  value: AttrValue,
});

const Span = z.object({
  traceId: z.string(),
  spanId: z.string(),
  name: z.string().optional(),
  startTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  endTimeUnixNano: z.union([z.string(), z.number()]).optional(),
  attributes: z.array(Attribute).optional(),
  status: z.object({ code: z.number().optional() }).optional(),
});

const ScopeSpans = z.object({ spans: z.array(Span).optional() });
const Resource = z.object({ attributes: z.array(Attribute).optional() });
const ResourceSpans = z.object({
  resource: Resource.optional(),
  scopeSpans: z.array(ScopeSpans).optional(),
});

export const TracePayload = z.object({ resourceSpans: z.array(ResourceSpans).optional() });

export type TracePayload = z.infer<typeof TracePayload>;

type Attr = { key: string; value: z.infer<typeof AttrValue> };

// First attribute wins. Repeated keys are legal in OTLP and last-wins would make
// the meaning depend on exporter ordering.
function attr(attrs: Attr[] | undefined, key: string): string | null {
  if (attrs === undefined) return null;
  for (const a of attrs) {
    if (a.key !== key) continue;
    const v = a.value;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.intValue !== undefined) return String(v.intValue);
    if (v.doubleValue !== undefined) return String(v.doubleValue);
    if (v.boolValue !== undefined) return String(v.boolValue);
  }
  return null;
}

function count(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  name: string;
  taskId: string | null;
  agent: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
  failed: boolean;
}

function nanos(raw: string | number | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Flattens a payload to one record per span that carries a model. A span with no
// `gen_ai.request.model` is not an LLM call and is dropped.
export function mapSpans(payload: TracePayload): SpanRecord[] {
  const out: SpanRecord[] = [];

  for (const rs of payload.resourceSpans ?? []) {
    const taskId = attr(rs.resource?.attributes, 'agentcap.task_id');
    const service = attr(rs.resource?.attributes, 'service.name');

    for (const scope of rs.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        const model = attr(span.attributes, 'gen_ai.request.model');
        if (model === null) continue;

        const start = nanos(span.startTimeUnixNano);
        const end = nanos(span.endTimeUnixNano);
        const latencyMs =
          start !== null && end !== null && end > start ? Math.round((end - start) / 1e6) : 0;

        out.push({
          traceId: span.traceId,
          spanId: span.spanId,
          name: span.name ?? 'llm',
          taskId,
          // The agent is the emitting service; gen_ai.system is the provider and
          // would collapse every agent into one row.
          agent: service ?? attr(span.attributes, 'gen_ai.system') ?? 'otel',
          model,
          promptTokens: count(attr(span.attributes, 'gen_ai.usage.input_tokens')),
          completionTokens: count(attr(span.attributes, 'gen_ai.usage.output_tokens')),
          latencyMs,
          failed: span.status?.code === 2,
        });
      }
    }
  }

  return out;
}
