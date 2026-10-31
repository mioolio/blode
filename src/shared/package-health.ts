import type { PackageVerification } from './package-signing';

export type PackageHealth = 'normal' | 'abnormal' | 'danger';
export function packageHealth(verification: Pick<PackageVerification, 'status'>): PackageHealth {
  if (verification.status === 'verified') return 'normal';
  return verification.status === 'invalid' || verification.status === 'tampered' ? 'danger' : 'abnormal';
}
