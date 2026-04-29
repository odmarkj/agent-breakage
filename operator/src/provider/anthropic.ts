import Anthropic from '@anthropic-ai/sdk';
import type { ChatParams, CostTier, LLMProvider, StreamEvent, ProviderContentBlock } from '../types.js';

const MODEL_MAP: Record<CostTier, string> = {
  low: 'claude-haiku-4-5-20251001',
  medium: 'claude-sonnet-4-20250514',
  high: 'claude-opus-4-20250514',
};

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private model: string;
  readonly costTier: CostTier;
  readonly name = 'anthropic';

  constructor(tier: CostTier) {
    this.client = new Anthropic();
    this.costTier = tier;
    this.model = MODEL_MAP[tier];
  }

  async *chat(params: ChatParams): AsyncGenerator<StreamEvent> {
    const messages: Anthropic.MessageParam[] = params.messages.map((m) => ({
      role: m.role,
      content: m.content as string | Anthropic.ContentBlockParam[],
    }));

    const tools: Anthropic.Tool[] | undefined = params.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool['input_schema'],
    }));

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: params.maxTokens ?? 8192,
      system: params.system,
      messages,
      tools,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }

    const finalMessage = await stream.finalMessage();

    // Emit tool_use events
    for (const block of finalMessage.content) {
      if (block.type === 'tool_use') {
        yield {
          type: 'tool_use',
          toolUse: {
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          },
        };
      }
    }

    yield {
      type: 'message_end',
      stopReason: finalMessage.stop_reason ?? undefined,
      content: finalMessage.content.map((block): ProviderContentBlock => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        }
        return { type: 'text', text: '' };
      }),
    };
  }

  async classify(prompt: string): Promise<string> {
    const response = await this.client.messages.create({
      model: MODEL_MAP.low, // always use cheapest for classification
      max_tokens: 50,
      messages: [{ role: 'user', content: prompt }],
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock?.type === 'text' ? textBlock.text.trim().toLowerCase() : 'ignore';
  }
}
