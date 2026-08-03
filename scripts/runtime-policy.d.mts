export interface RuntimePolicyResult {
  valid: boolean;
  reason: string | null;
}
export function parseVersion(value: string): {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
} | null;
export function validateRuntimePolicy(nodeVersion: string, npmVersion: string): RuntimePolicyResult;
