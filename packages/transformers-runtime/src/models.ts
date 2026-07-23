import type { TransformersDtype, TransformersTask } from "./types"

export interface TransformersModelPreset {
  task: TransformersTask
  modelId: string
  label: string
  description: string
  recommendedDtype: TransformersDtype
}

/** Curated small browser-compatible defaults. Consumers may always supply another Hub model ID. */
export const TRANSFORMERS_MODEL_PRESETS: readonly TransformersModelPreset[] = [
  {
    task: "feature-extraction",
    modelId: "Xenova/all-MiniLM-L6-v2",
    label: "MiniLM L6 v2",
    description: "Compact English sentence embeddings",
    recommendedDtype: "q8",
  },
  {
    task: "feature-extraction",
    modelId: "Xenova/multilingual-e5-small",
    label: "Multilingual E5 Small",
    description: "Multilingual sentence embeddings",
    recommendedDtype: "q8",
  },
  {
    task: "text-classification",
    modelId: "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
    label: "DistilBERT SST-2",
    description: "English sentiment classification",
    recommendedDtype: "q8",
  },
  {
    task: "translation",
    modelId: "Xenova/nllb-200-distilled-600M",
    label: "NLLB 200 Distilled",
    description: "Multilingual translation",
    recommendedDtype: "q4",
  },
  {
    task: "summarization",
    modelId: "Xenova/distilbart-cnn-6-6",
    label: "DistilBART CNN",
    description: "English text summarization",
    recommendedDtype: "q8",
  },
  {
    task: "text-generation",
    modelId: "onnx-community/Qwen2.5-0.5B-Instruct",
    label: "Qwen 2.5 0.5B Instruct",
    description: "Compact instruction-following text generation",
    recommendedDtype: "q4",
  },
  {
    task: "question-answering",
    modelId: "Xenova/distilbert-base-cased-distilled-squad",
    label: "DistilBERT SQuAD",
    description: "Extractive question answering",
    recommendedDtype: "q8",
  },
  {
    task: "automatic-speech-recognition",
    modelId: "Xenova/whisper-tiny",
    label: "Whisper Tiny",
    description: "Compact multilingual speech recognition",
    recommendedDtype: "q8",
  },
  {
    task: "image-classification",
    modelId: "Xenova/vit-base-patch16-224",
    label: "ViT Base",
    description: "General image classification",
    recommendedDtype: "q8",
  },
  {
    task: "object-detection",
    modelId: "Xenova/detr-resnet-50",
    label: "DETR ResNet-50",
    description: "General object detection",
    recommendedDtype: "q8",
  },
] as const

export function getModelPresetsForTask(task: TransformersTask): TransformersModelPreset[] {
  return TRANSFORMERS_MODEL_PRESETS.filter((preset) => preset.task === task)
}
