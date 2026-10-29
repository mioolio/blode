export type CompilerFamily = 'inherit' | 'auto' | 'gnu-arm' | 'armclang' | 'arduino';

export interface CompilerChoice {
  family: CompilerFamily;
  directory?: string;
  version?: string;
  arduinoCli?: string;
  packageDirectory?: string;
}

export interface PlatformCompilerSettings {
  common?: CompilerChoice;
  c?: CompilerChoice;
  cpp?: CompilerChoice;
}

export interface BuildSettings {
  mode?: 'debug' | 'release';
  optimizeForSize?: boolean;
  common?: CompilerChoice;
  platforms?: Partial<Record<'stm32' | 'esp32-s3', PlatformCompilerSettings>>;
}
