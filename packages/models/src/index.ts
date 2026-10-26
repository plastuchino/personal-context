import {validateTasks,type TaskExtraction} from './tasks.js';
import { ollamaCall } from './ollama.js';
import type { Config, ModelConfig } from '@personal-context/config';
import { labels, type Label } from '@personal-context/contracts';

export interface ModelIdentity { model: string; version: string }
export interface Classification {
  labels: Exclude<Label, 'unorganized'>[];
  reason: string;
  confidence: number | null;
  personal_evidence?:string|null;
}
export interface VisionResult { description: string; ocr: string }
export interface ModelAdapters {
  extractTasks(text:string):Promise<TaskExtraction>;
  embed(texts: string[]): Promise<number[][]>;
  classify(text: string): Promise<Classification>;
  describe(image: { mimeType: string; base64: string }): Promise<VisionResult>;
}

// Provider-neutral gateway contract. Concrete providers can implement the same
// interfaces without coupling workers to an SDK or silently selecting a model.
export function createModelAdapters(config: Config, request: typeof fetch = fetch): ModelAdapters {
  async function call(model: ModelConfig | null, input: unknown): Promise<unknown> {
    if (!model) throw new Error('Model processing is disabled until configured');
    if(model.adapter==='ollama')return ollamaCall(model,input,request);
    const response = await request(model.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}) },
      body: JSON.stringify({ model: model.model, version: model.version, input }),
      signal: AbortSignal.timeout(model.timeoutMs??60000),
    });
    if (!response.ok) throw new Error(`Model service returned HTTP ${response.status}`);
    return response.json();
  }
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model output');
    return value as Record<string, unknown>;
  };
  return {
    async extractTasks(text){return validateTasks(await call(config.classifier,{task_text:text}));},
    async embed(texts) {
      if (!texts.length || texts.some((x) => !x.trim())) throw new Error('Embedding input must contain nonempty text');
      const value = object(await call(config.embedding, { texts })).embeddings;
      if (!Array.isArray(value) || value.length !== texts.length || !value.every((v) => Array.isArray(v) && v.length === config.embedding!.dimensions && v.every((x) => typeof x === 'number' && Number.isFinite(x)) && v.some((x) => x !== 0))) throw new Error('Embedding output does not match the pinned dimensions');
      return value as number[][];
    },
    async classify(text) {
      const value = object(await call(config.classifier, { text }));
      if (!Array.isArray(value.labels) || !value.labels.length || !value.labels.every((x) => labels.includes(x) && x !== 'unorganized') || typeof value.reason !== 'string' || !value.reason.trim() || !(value.confidence === null || typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1)) throw new Error('Invalid classification output');
      return { labels: [...new Set(value.labels)] as Classification['labels'], reason: value.reason, confidence: value.confidence as number | null,...(typeof value.personal_evidence==='string'?{personal_evidence:value.personal_evidence}:{}) };
    },
    async describe(image) {
      const value = object(await call(config.vision, { image }));
      if (typeof value.description !== 'string' || !value.description.trim() || typeof value.ocr !== 'string') throw new Error('Invalid vision output');
      return { description: value.description, ocr: value.ocr };
    },
  };
}
