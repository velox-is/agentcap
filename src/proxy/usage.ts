import { z } from 'zod';

// Boundary validation for the two stream shapes. No `any`; every field the
// counter reads is checked, and a frame that fails is ignored rather than
// trusted.

const OpenAiUsage = z.object({
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
});

const OpenAiChunk = z.object({
  choices: z
    .array(
      z.object({
        delta: z
          .object({ content: z.string().nullish(), reasoning_content: z.string().nullish() })
          .nullish(),
      }),
    )
    .nullish(),
  usage: OpenAiUsage.nullish(),
});

const AnthropicUsageStart = z.object({
  input_tokens: z.number().nonnegative(),
  cache_read_input_tokens: z.number().nonnegative().nullish(),
  cache_creation_input_tokens: z.number().nonnegative().nullish(),
});

const AnthropicFrame = z.object({
  type: z.string(),
  message: z.object({ usage: AnthropicUsageStart.nullish() }).nullish(),
  usage: z.object({ output_tokens: z.number().nonnegative().nullish() }).nullish(),
  delta: z
    .object({
      text: z.string().nullish(),
      thinking: z.string().nullish(),
      partial_json: z.string().nullish(),
    })
    .nullish(),
});

// What a single frame contributes. Everything is optional: a frame may carry
// text, usage, both, or neither, and each shape fills whichever it has.
export interface FrameUsage {
  text: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

export const EMPTY_USAGE: FrameUsage = { text: '', promptTokens: null, completionTokens: null };

export function extractOpenAi(payload: unknown): FrameUsage {
  const parsed = OpenAiChunk.safeParse(payload);
  if (!parsed.success) return EMPTY_USAGE;
  const delta = parsed.data.choices?.[0]?.delta;
  const usage = parsed.data.usage;
  return {
    text: delta?.content ?? delta?.reasoning_content ?? '',
    promptTokens: usage?.prompt_tokens ?? null,
    completionTokens: usage?.completion_tokens ?? null,
  };
}

export function extractAnthropic(payload: unknown): FrameUsage {
  const parsed = AnthropicFrame.safeParse(payload);
  if (!parsed.success) return EMPTY_USAGE;
  const body = parsed.data;

  if (body.type === 'message_start') {
    const usage = body.message?.usage;
    if (usage == null) return EMPTY_USAGE;
    return {
      text: '',
      promptTokens:
        usage.input_tokens +
        (usage.cache_read_input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0),
      completionTokens: null,
    };
  }

  if (body.type === 'content_block_delta') {
    return {
      text: body.delta?.text ?? body.delta?.thinking ?? body.delta?.partial_json ?? '',
      promptTokens: null,
      completionTokens: null,
    };
  }

  if (body.type === 'message_delta') {
    return { text: '', promptTokens: null, completionTokens: body.usage?.output_tokens ?? null };
  }

  return EMPTY_USAGE;
}
