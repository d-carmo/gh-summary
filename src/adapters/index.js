/**
 * Provider Adapter Factory
 * Creates and manages provider-specific adapters for different deployment targets
 */

import { VercelAdapter } from "./vercel.js";
import { LambdaAdapter } from "./lambda.js";

/**
 * Create adapter based on environment configuration
 */
export function createAdapter(provider = process.env.PROVIDER || 'vercel') {
  const adapters = {
    vercel: () => new VercelAdapter(),
    aws: () => new LambdaAdapter(),
  };

  if (!adapters[provider]) {
    throw new Error(`Unknown provider: ${provider}. Use 'vercel' or 'aws'.`);
  }

  return adapters[provider]();
}

export default createAdapter;
