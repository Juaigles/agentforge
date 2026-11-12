import { msg } from '../../../shared/server-messages';
import { ConfigError } from '../errors';
import { OllamaClient } from './ollama';
import { OpenAiCompatibleClient } from './openai';
import type { LlmClient, LlmFactory, LlmProviderConfig } from './types';

export * from './types';

/** Fábrica real: crea el cliente adecuado según el tipo de proveedor. */
export const defaultLlmFactory: LlmFactory = {
  create(provider: LlmProviderConfig): LlmClient {
    switch (provider.kind) {
      case 'ollama':
        return new OllamaClient(provider.baseUrl, provider.apiKey);
      case 'openai':
        return new OpenAiCompatibleClient(provider.baseUrl, provider.apiKey);
      default:
        throw new ConfigError(msg('providerKindUnsupported', { kind: String((provider as LlmProviderConfig).kind) }));
    }
  },
};
