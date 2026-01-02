import { customProvider } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import {
  artifactModel,
  chatModel,
  reasoningModel,
  titleModel,
} from './models.test';
import { isTestEnvironment } from '../constants';

export const myProvider = isTestEnvironment
  ? customProvider({
      languageModels: {
        'chat-model': chatModel,
        'chat-model-reasoning': reasoningModel,
        'title-model': titleModel,
        'artifact-model': artifactModel,
      },
    })
  : customProvider({
      languageModels: {
        'chat-model': anthropic('claude-sonnet-4-20250514'),
        'chat-model-reasoning': anthropic('claude-sonnet-4-20250514'),
        'title-model': anthropic('claude-haiku-3-5-20241022'),
        'artifact-model': anthropic('claude-sonnet-4-20250514'),
      },
      // Note: Anthropic does not support image generation
    });
