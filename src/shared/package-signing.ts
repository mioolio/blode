export type PackageKind = 'device' | 'extension' | 'component' | 'tool' | 'application';
export interface PackageSubject {
  kind: PackageKind;
  id: string;
  version: string;
}
export interface PackageVerification {
  status: 'verified' | 'unsigned' | 'untrusted' | 'invalid' | 'tampered';
  fingerprint: string;
  signatureValid: boolean;
  trusted: boolean;
  integrityValid: boolean;
  publisher?: string;
  keyId?: string;
  signedAt?: string;
  subject?: PackageSubject;
  changed: string[];
}
export interface PackageApproval {
  fingerprint: string;
  allowUntrusted?: true;
  allowModified?: true;
}
export interface PackageSigningApi {
  packageInspect(request: { path: string; kind: PackageKind }): Promise<PackageVerification>;
}
