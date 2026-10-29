export type CompilerFamily = 'inherit' | 'auto' | 'gnu-arm' | 'armclang' | 'arduino' | 'plugin';

export interface CompilerChoice {
  family: CompilerFamily;
  pluginId?: string;
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
  platforms?: Record<string, PlatformCompilerSettings>;
}
