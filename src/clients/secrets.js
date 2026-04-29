/**
 * AWS Secrets Manager client
 * Fetches secrets at runtime for Lambda functions
 */
import { 
  SecretsManagerClient, 
  GetSecretValueCommand 
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});

let cachedSecrets = null;

export async function getSecret(secretName) {
  if (cachedSecrets) return cachedSecrets;

  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(command);

  cachedSecrets = JSON.parse(response.SecretString);
  return cachedSecrets;
}

export function getEnvVar(key) {
  return cachedSecrets?.[key];
}