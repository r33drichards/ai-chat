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
        'chat-model': anthropic('claude-sonnet-4-5'),
        'chat-model-reasoning': anthropic('claude-sonnet-4-5'),
        'title-model': anthropic('claude-haiku-4-5'),
        'artifact-model': anthropic('claude-sonnet-4-5'),
      },
      // Note: Anthropic does not support image generation
    });
