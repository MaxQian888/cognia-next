// Re-export shim: canonical source moved to @cognia/provider-embedding (Stage 3).
export {
  binarizeVector,
  cosineSimilarityBinary,
  dequantizeVector,
  quantizeVector,
} from "@cognia/provider-embedding/quantization"
export type { QuantizationConfig, QuantizedVector } from "@cognia/provider-embedding/quantization"
