import { createDocumentHandler } from '@/lib/artifacts/server';

export const imageDocumentHandler = createDocumentHandler<'image'>({
  kind: 'image',
  onCreateDocument: async () => {
    throw new Error(
      'Image generation is not supported with the Anthropic provider.',
    );
  },
  onUpdateDocument: async () => {
    throw new Error(
      'Image generation is not supported with the Anthropic provider.',
    );
  },
});
